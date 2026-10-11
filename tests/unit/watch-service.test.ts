import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImportOptions, MediaStatus } from '../../src/shared/media'
import { runMigrations } from '../../src/main/db/migrations'
import type { SqlDriver } from '../../src/main/db/driver'
import { ImportService } from '../../src/main/media/import-service'
import { pathKey } from '../../src/main/media/files'
import { ContentsRepository } from '../../src/main/repositories/contents'
import { ProjectsRepository } from '../../src/main/repositories/projects'
import { WatchFoldersRepository } from '../../src/main/repositories/watch-folders'
import { isIgnoredFileName, WatchService, type KnownFile, type WatchFactory } from '../../src/main/watch/watch-service'
import { CreateProjectInputSchema } from '../../src/shared/schemas'
import { createFixtures, testTools, type Fixtures } from '../helpers/media'
import { createNodeSqliteDriver, memoryLogger, tempDir } from '../helpers/node-sqlite-driver'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean, timeoutMs = 8000, message = 'condition'): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${message}`)
    await sleep(10)
  }
}

/** A watcher that never reports anything, like a network drive that sends no events. */
const silentWatcher: WatchFactory = () => ({ close: () => {} })

/**
 * Fake importer standing in for ImportService: records calls and marks the
 * files as known, the way a real import inserts them into the library.
 */
function fakeLibrary() {
  const known = new Map<string, KnownFile>()
  const calls: { paths: string[]; options: ImportOptions; sizes: number[] }[] = []
  let failNext = 0
  return {
    known,
    calls,
    imported: () => calls.flatMap((c) => c.paths.map((p) => p.split(/[\\/]/).pop()!)).sort(),
    failNextImports(n: number) {
      failNext = n
    },
    setStatus(path: string, status: MediaStatus) {
      const entry = known.get(pathKey(path))!
      known.set(pathKey(path), { ...entry, status })
    },
    importer: async (paths: string[], options: ImportOptions) => {
      if (failNext > 0) {
        failNext--
        throw new Error('FFmpeg unavailable (test)')
      }
      calls.push({ paths, options, sizes: paths.map((p) => statSync(p).size) })
      for (const p of paths) {
        const info = statSync(p)
        known.set(pathKey(p), { id: p, status: 'ready', size: info.size, mtimeMs: info.mtimeMs })
      }
    }
  }
}

describe('isIgnoredFileName', () => {
  it('ignores hidden, lock and partial files', () => {
    for (const name of ['.clip.mp4', '~$clip.mp4', 'clip.mp4.part', 'clip.mp4.tmp', 'clip.mp4.crdownload', 'render.mp4.partial']) {
      expect(isIgnoredFileName(name), name).toBe(true)
    }
    for (const name of ['clip.mp4', 'MMA Drop 001.mov', 'final.part1.mp4']) {
      expect(isIgnoredFileName(name), name).toBe(false)
    }
  })
})

describe('WatchService', () => {
  const root = tempDir('sm-watch-')
  let db: SqlDriver
  let folders: WatchFoldersRepository
  let projects: ProjectsRepository
  let library: ReturnType<typeof fakeLibrary>
  let service: WatchService | null
  let dir: string
  let statuses: number

  beforeEach(() => {
    db = createNodeSqliteDriver()
    runMigrations(db)
    folders = new WatchFoldersRepository(db)
    projects = new ProjectsRepository(db)
    library = fakeLibrary()
    service = null
    statuses = 0
    dir = join(root.path, `out-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir)
  })
  afterEach(() => {
    service?.stop()
    db.close()
  })
  afterAll(() => root.cleanup())

  const makeService = (options: { watchFactory?: WatchFactory; scanIntervalMs?: number; stabilityIntervalMs?: number } = {}) =>
    new WatchService({
      folders,
      knownFiles: () => library.known,
      importer: library.importer,
      logger: memoryLogger(),
      emit: () => {
        statuses++
      },
      scanIntervalMs: () => options.scanIntervalMs ?? 60_000,
      stabilityIntervalMs: options.stabilityIntervalMs ?? 40,
      stableChecksRequired: 2,
      watchFactory: options.watchFactory
    })

  const addFolder = (path = dir, origin: 'drop_machine' | 'watch_folder' = 'drop_machine', projectId: string | null = null) =>
    folders.add({ path, pathKey: pathKey(path), origin, projectId })

  it('imports videos already in the folder on start, with the folder’s project and origin', async () => {
    const mma = projects.create(CreateProjectInputSchema.parse({ name: 'MMA' }))
    mkdirSync(join(dir, 'batch 2'))
    writeFileSync(join(dir, 'drop-001.mp4'), 'video 1')
    writeFileSync(join(dir, 'batch 2', 'drop-002.mov'), 'video 2')
    writeFileSync(join(dir, 'project.json'), '{}')
    writeFileSync(join(dir, 'drop-003.mp4.part'), 'still rendering')
    writeFileSync(join(dir, 'music.mp3'), 'audio is not a video')
    const folder = addFolder(dir, 'drop_machine', mma.id)

    service = makeService()
    await service.start()
    await service.waitForIdle()

    expect(library.imported()).toEqual(['drop-001.mp4', 'drop-002.mov'])
    expect(library.calls[0]!.options).toEqual({ projectId: mma.id, origin: 'drop_machine', watchFolderId: folder.id })
    expect(service.status()[0]).toMatchObject({ id: folder.id, state: 'watching', waitingFiles: 0, lastError: null })
    expect(folders.get(folder.id).lastScanAt).not.toBeNull()
    expect(statuses).toBeGreaterThan(0)
  })

  it('waits until a file stops growing before importing it', async () => {
    addFolder()
    // Writes every ~25 ms; a file must be unchanged for 2 checks 150 ms apart, so a slow machine can't
    // make a pause between two writes look like a finished file.
    service = makeService({ stabilityIntervalMs: 150 })
    await service.start()

    const file = join(dir, 'render.mp4')
    writeFileSync(file, 'x')
    // Keep "rendering" for several stability checks.
    for (let i = 0; i < 8; i++) {
      await sleep(25)
      appendFileSync(file, 'more data '.repeat(100))
      expect(library.calls).toHaveLength(0)
    }
    const finalSize = statSync(file).size
    await waitFor(() => library.calls.length > 0, 8000, 'import after the file settled')
    expect(library.calls[0]!.sizes).toEqual([finalSize])
    expect(library.calls).toHaveLength(1)
  })

  it('never imports a known file twice, and does not modify anything in the folder', async () => {
    const file = join(dir, 'clip.mp4')
    writeFileSync(file, 'content')
    const before = { ...statSync(file), data: readFileSync(file, 'utf8') }
    addFolder()

    service = makeService()
    await service.start()
    await service.waitForIdle()
    await service.scanNow()
    await service.waitForIdle()
    expect(library.imported()).toEqual(['clip.mp4'])

    const after = statSync(file)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(readFileSync(file, 'utf8')).toBe(before.data)
  })

  it('finds files created while the app was closed (reconciliation on start)', async () => {
    addFolder()
    writeFileSync(join(dir, 'before.mp4'), 'a')
    service = makeService()
    await service.start()
    await service.waitForIdle()
    service.stop()

    // App closed: nothing is watching.
    writeFileSync(join(dir, 'while-closed.mp4'), 'b')
    await sleep(100)
    expect(library.imported()).toEqual(['before.mp4'])

    service = makeService({ watchFactory: silentWatcher })
    await service.start()
    await service.waitForIdle()
    expect(library.imported()).toEqual(['before.mp4', 'while-closed.mp4'])
  })

  it('detects new files from file-system events, without waiting for a rescan', async () => {
    addFolder()
    service = makeService({ scanIntervalMs: 600_000 })
    await service.start()
    await service.waitForIdle()

    writeFileSync(join(dir, 'live.mp4'), 'new clip')
    await waitFor(() => library.calls.length > 0, 8000, 'event-driven import')
    expect(library.imported()).toEqual(['live.mp4'])
  })

  it('still finds new files when the system never reports them (periodic rescan)', async () => {
    addFolder()
    service = makeService({ watchFactory: silentWatcher, scanIntervalMs: 100 })
    await service.start()
    await service.waitForIdle()

    writeFileSync(join(dir, 'missed-event.mp4'), 'clip')
    await waitFor(() => library.calls.length > 0, 8000, 'rescan import')
    expect(library.imported()).toEqual(['missed-event.mp4'])
  })

  it('falls back to periodic scans when the watcher fails', async () => {
    let fail: ((error: Error) => void) | null = null
    const failing: WatchFactory = (_dir, _onChange, onError) => {
      fail = onError
      return { close: () => {} }
    }
    addFolder()
    service = makeService({ watchFactory: failing, scanIntervalMs: 100 })
    await service.start()
    expect(service.status()[0]!.state).toBe('watching')

    fail!(new Error('EPERM: watcher died'))
    expect(service.status()[0]!.state).toBe('polling')

    writeFileSync(join(dir, 'after-failure.mp4'), 'clip')
    await waitFor(() => library.calls.length > 0, 8000, 'import after watcher failure')
    // The next scan re-attaches the watcher.
    await waitFor(() => service!.status()[0]!.state === 'watching', 8000, 'watcher re-attached')
  })

  it('reports a missing folder and starts watching once it appears', async () => {
    const later = join(dir, 'not-yet')
    addFolder(later)
    service = makeService({ scanIntervalMs: 100 })
    await service.start()
    expect(service.status()[0]).toMatchObject({ state: 'unavailable' })
    expect(service.status()[0]!.lastError).toContain('não foi encontrada')

    mkdirSync(later)
    writeFileSync(join(later, 'first.mp4'), 'clip')
    await waitFor(() => library.calls.length > 0, 8000, 'import once the folder exists')
    expect(service.status()[0]).toMatchObject({ state: 'watching', lastError: null })
  })

  it('skips disabled folders and picks them up when re-enabled', async () => {
    const folder = addFolder()
    folders.update(folder.id, { enabled: false })
    writeFileSync(join(dir, 'paused.mp4'), 'clip')
    service = makeService()
    await service.start()
    await service.waitForIdle()
    expect(library.calls).toHaveLength(0)
    expect(service.status()[0]!.state).toBe('disabled')

    folders.update(folder.id, { enabled: true })
    await service.refresh()
    await service.waitForIdle()
    expect(library.imported()).toEqual(['paused.mp4'])
  })

  it('starts and stops watching folders that are added or removed', async () => {
    service = makeService()
    await service.start()
    expect(service.status()).toEqual([])

    writeFileSync(join(dir, 'existing.mp4'), 'clip')
    const folder = addFolder()
    await service.refresh()
    await service.waitForIdle()
    expect(library.imported()).toEqual(['existing.mp4'])

    folders.remove(folder.id)
    await service.refresh()
    expect(service.status()).toEqual([])
    writeFileSync(join(dir, 'after-removal.mp4'), 'clip')
    await sleep(200)
    expect(library.imported()).toEqual(['existing.mp4'])
  })

  it('retries files whose import was deferred (e.g. FFmpeg unavailable)', async () => {
    addFolder()
    writeFileSync(join(dir, 'clip.mp4'), 'clip')
    library.failNextImports(1)
    service = makeService({ scanIntervalMs: 100 })
    await service.start()
    await waitFor(() => library.calls.length > 0, 8000, 'retry after a failed import')
    expect(library.imported()).toEqual(['clip.mp4'])
  })

  it('reconsiders a failed file once it changes on disk', async () => {
    addFolder()
    const file = join(dir, 'half.mp4')
    writeFileSync(file, 'half')
    service = makeService({ scanIntervalMs: 100 })
    await service.start()
    await service.waitForIdle()
    expect(library.calls).toHaveLength(1)

    // The import failed (e.g. the file was incomplete). Unchanged, it is left alone...
    library.setStatus(file, 'error')
    await sleep(300)
    expect(library.calls).toHaveLength(1)

    // ...once it changes, it is handed to the importer again.
    appendFileSync(file, ' and the rest')
    await waitFor(() => library.calls.length > 1, 8000, 'second import of the changed file')
  })
})

const tools = testTools()

describe.skipIf(!tools)('WatchService with the real import pipeline', () => {
  const root = tempDir('sm-watch-e2e-')
  let fx: Fixtures

  beforeAll(() => {
    fx = createFixtures(tools!, join(root.path, 'fixtures'))
  })
  afterAll(() => root.cleanup())

  it('imports a render that is written progressively, once, into the folder’s project as “needs review”', async () => {
    const db = createNodeSqliteDriver()
    runMigrations(db)
    const contents = new ContentsRepository(db)
    const projects = new ProjectsRepository(db)
    const folders = new WatchFoldersRepository(db)
    const skate = projects.create(CreateProjectInputSchema.parse({ name: 'Skate' }))
    const output = join(root.path, 'drop-machine-output')
    mkdirSync(output)
    const folder = folders.add({ path: output, pathKey: pathKey(output), origin: 'drop_machine', projectId: skate.id })
    const thumbs = join(root.path, 'thumbs')
    const temp = join(root.path, 'temp')
    mkdirSync(thumbs)
    mkdirSync(temp)

    const importer = new ImportService({
      repo: contents,
      getTools: async () => ({ ffmpeg: tools!.ffmpeg, ffprobe: tools!.ffprobe }),
      thumbnailsDirectory: thumbs,
      tempDirectory: temp,
      logger: memoryLogger(),
      emit: () => {}
    })
    const watcher = new WatchService({
      folders,
      knownFiles: () => contents.knownFiles(),
      importer: (paths, options) => importer.importPaths(paths, options),
      logger: memoryLogger(),
      emit: () => {},
      scanIntervalMs: () => 200,
      stabilityIntervalMs: 50,
      stableChecksRequired: 3
    })

    try {
      await watcher.start()

      // Write the video in chunks, like a renderer would.
      const data = readFileSync(fx.vertical)
      const target = join(output, 'Skate Drop 004.mp4')
      const chunk = Math.ceil(data.length / 6)
      for (let i = 0; i < data.length; i += chunk) {
        appendFileSync(target, data.subarray(i, i + chunk))
        await sleep(40)
      }

      await waitFor(() => contents.list().some((c) => c.status === 'ready'), 15_000, 'ready content')
      await importer.waitForIdle()
      await watcher.waitForIdle()

      const items = contents.list()
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        fileName: 'Skate Drop 004.mp4',
        status: 'ready',
        projectId: skate.id,
        origin: 'drop_machine',
        watchFolderId: folder.id,
        workflowStatus: 'needs_review',
        width: 180,
        height: 320,
        hasThumbnail: true
      })

      // A rename in the folder keeps the same entry (id, project, status).
      const renamed = join(output, 'Skate Drop 004 - kickflip.mp4')
      contents.setWorkflowStatus([items[0]!.id], 'ready')
      renameSync(target, renamed)
      await waitFor(() => contents.list()[0]?.fileName === 'Skate Drop 004 - kickflip.mp4', 15_000, 'rename followed')
      await importer.waitForIdle()
      expect(contents.list()).toHaveLength(1)
      expect(contents.list()[0]).toMatchObject({ id: items[0]!.id, workflowStatus: 'ready', availability: 'online' })

      // A copy of the same clip is not a new content.
      copyFileSync(renamed, join(output, 'copy of drop.mp4'))
      await sleep(800)
      await importer.waitForIdle()
      await watcher.waitForIdle()
      expect(contents.list()).toHaveLength(1)
    } finally {
      watcher.stop()
      importer.shutdown()
      db.close()
      rmSync(output, { recursive: true, force: true })
    }
  })
})

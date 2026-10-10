import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContentItem, MediaEvent } from '../../src/shared/media'
import { openDatabase } from '../../src/main/db/open'
import type { SqlDriver } from '../../src/main/db/driver'
import { UnavailableError } from '../../src/main/errors'
import { ImportService } from '../../src/main/media/import-service'
import { ContentsRepository } from '../../src/main/repositories/contents'
import { ProjectsRepository } from '../../src/main/repositories/projects'
import { CreateProjectInputSchema } from '../../src/shared/schemas'
import { createNodeSqliteDriver, memoryLogger, tempDir } from '../helpers/node-sqlite-driver'
import { createFixtures, testTools, type Fixtures } from '../helpers/media'

const tools = testTools()

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 2))
  }
}

describe.skipIf(!tools)('ImportService with real FFmpeg and SQLite', () => {
  const root = tempDir('sm-import-')
  let fx: Fixtures
  let work: string
  let db: SqlDriver
  let repo: ContentsRepository
  let events: MediaEvent[]
  let service: ImportService
  let available: boolean
  const appData = join(root.path, 'app-data')
  const thumbs = join(appData, 'thumbnails')
  const temp = join(appData, 'temp')
  const dbOptions = () => ({
    databasePath: join(appData, 'database.sqlite'),
    backupsDirectory: join(appData, 'backups'),
    createDriver: createNodeSqliteDriver,
    logger: memoryLogger()
  })

  const makeService = () =>
    new ImportService({
      repo,
      getTools: async () => {
        if (!available) throw new UnavailableError('FFmpeg is missing (test).')
        return { ffmpeg: tools!.ffmpeg, ffprobe: tools!.ffprobe }
      },
      thumbnailsDirectory: thumbs,
      tempDirectory: temp,
      logger: memoryLogger(),
      emit: (e) => events.push(e)
    })

  beforeAll(() => {
    fx = createFixtures(tools!, join(root.path, 'fixtures'))
  })
  afterAll(() => root.cleanup())

  beforeEach(() => {
    rmSync(appData, { recursive: true, force: true })
    mkdirSync(thumbs, { recursive: true })
    mkdirSync(temp, { recursive: true })
    work = join(root.path, `work-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(work)
    db = openDatabase(dbOptions()).db
    repo = new ContentsRepository(db)
    events = []
    available = true
    service = makeService()
  })
  afterEach(() => {
    service.shutdown()
    db.close()
  })

  /** Copies fixtures into a fresh folder so tests can move/delete them. */
  const stage = (...paths: string[]) =>
    paths.map((p) => {
      const target = join(work, p.split(/[\\/]/).pop()!)
      copyFileSync(p, target)
      return target
    })

  const byName = (name: string): ContentItem => {
    const asset = repo.list().find((a) => a.fileName === name)
    if (!asset) throw new Error(`${name} not in library: ${repo.list().map((a) => a.fileName).join(', ')}`)
    return asset
  }

  it('imports real videos, extracts metadata and makes thumbnails', async () => {
    const [mp4, vertical] = stage(fx.mp4, fx.vertical)
    const summary = await service.importPaths([mp4!, vertical!])
    expect(summary).toMatchObject({ queued: 2, alreadyInLibrary: 0, errors: [] })
    await service.waitForIdle()

    const video = byName('clip.mp4')
    expect(video).toMatchObject({ kind: 'video', status: 'ready', width: 320, height: 240, frameRate: 30, videoCodec: 'h264', audioCodec: 'aac', hasThumbnail: true })
    expect(existsSync(join(thumbs, `${video.id}.jpg`))).toBe(true)

    const portrait = byName('vertical.mp4')
    expect(portrait).toMatchObject({ status: 'ready', width: 180, height: 320, hasThumbnail: true })
    expect(portrait.durationSeconds).toBeGreaterThan(1.9)

    // Manual imports start as "imported", without a project.
    expect(video).toMatchObject({ origin: 'manual', workflowStatus: 'imported', projectId: null, watchFolderId: null })

    // Progress was reported, ending idle.
    const queueEvents = events.filter((e) => e.type === 'queue')
    expect(queueEvents.some((e) => e.type === 'queue' && e.state.active)).toBe(true)
    expect(service.queueState().active).toBe(false)
  })

  it('records the project, origin and workflow status given with an import', async () => {
    const projects = new ProjectsRepository(db)
    const mma = projects.create(CreateProjectInputSchema.parse({ name: 'MMA' }))
    const [mp4] = stage(fx.mp4)
    await service.importPaths([mp4!], { projectId: mma.id, origin: 'drop_machine' })
    await service.waitForIdle()
    // Videos arriving from Drop Machine or a watched folder need review by default.
    expect(byName('clip.mp4')).toMatchObject({ projectId: mma.id, origin: 'drop_machine', workflowStatus: 'needs_review' })
  })

  it('rejects files without a picture: audio-only files and still images', async () => {
    const files = stage(fx.wav, fx.mp3WithCover, fx.still)
    await service.importPaths(files)
    await service.waitForIdle()
    expect(byName('tone.wav')).toMatchObject({ status: 'error' })
    expect(byName('tone.wav').errorMessage).toContain('apenas vídeos')
    // Cover art is not a video.
    expect(byName('cover.mp3').errorMessage).toContain('apenas vídeos')
    expect(byName('still.png').errorMessage).toContain('imagem parada')
  })

  it('keeps everything after closing and reopening the database', async () => {
    const [mp4, mov] = stage(fx.mp4, fx.mov)
    await service.importPaths([mp4!, mov!])
    await service.waitForIdle()
    const before = repo.list()
    service.shutdown()
    db.close()

    db = openDatabase(dbOptions()).db
    repo = new ContentsRepository(db)
    service = makeService()
    service.start()
    await service.waitForIdle()
    expect(repo.list()).toEqual(before)
    expect(repo.list().every((a) => a.status === 'ready')).toBe(true)
  })

  it('imports a folder recursively, considering only video files', async () => {
    const nested = join(work, 'takes', 'day 1')
    mkdirSync(nested, { recursive: true })
    copyFileSync(fx.mp4, join(work, 'clip.mp4'))
    copyFileSync(fx.mov, join(nested, 'clip.mov'))
    copyFileSync(fx.notes, join(nested, 'notes.txt'))
    copyFileSync(fx.wav, join(nested, 'tone.wav'))
    mkdirSync(join(work, '.hidden'))
    copyFileSync(fx.vertical, join(work, '.hidden', 'secret.mp4'))

    const summary = await service.importPaths([work])
    expect(summary).toMatchObject({ queued: 2, skippedNonMedia: 2, truncated: false })
    await service.waitForIdle()
    expect(repo.list().map((a) => a.fileName).sort()).toEqual(['clip.mov', 'clip.mp4'])
  })

  it('records clear errors for invalid media and keeps going', async () => {
    const files = stage(fx.corrupt, fx.textAsMp3, fx.truncated, fx.mov)
    const summary = await service.importPaths(files)
    expect(summary.queued).toBe(4)
    await service.waitForIdle()

    for (const name of ['corrupt.mp4', 'not-really.mp3', 'truncated.mp4']) {
      const a = byName(name)
      expect(a.status, name).toBe('error')
      expect(a.errorMessage, name).toContain(name)
      expect(a.kind, name).toBeNull()
    }
    expect(byName('clip.mov').status).toBe('ready')
  })

  it('does not import the same file twice, by path or by content', async () => {
    const [mp4] = stage(fx.mp4)
    await service.importPaths([mp4!])
    await service.waitForIdle()

    const again = await service.importPaths([mp4!])
    expect(again).toMatchObject({ queued: 0, alreadyInLibrary: 1 })

    const copy = join(work, 'clip copy.mp4')
    copyFileSync(mp4!, copy)
    await service.importPaths([copy])
    await service.waitForIdle()
    expect(repo.list()).toHaveLength(1)
    expect(events).toContainEqual({ type: 'duplicate', fileName: 'clip copy.mp4', existingFileName: 'clip.mp4' })
  })

  it('treats a renamed file as the same content: the entry follows the new name', async () => {
    const projects = new ProjectsRepository(db)
    const skate = projects.create(CreateProjectInputSchema.parse({ name: 'Skate' }))
    const [mp4] = stage(fx.mp4)
    await service.importPaths([mp4!], { projectId: skate.id })
    await service.waitForIdle()
    const original = byName('clip.mp4')
    repo.setWorkflowStatus([original.id], 'ready')

    const renamed = join(work, 'kickflip final.mp4')
    renameSync(mp4!, renamed)
    await service.importPaths([renamed])
    await service.waitForIdle()

    // Still one entry, with its id, project and status, now pointing at the new path.
    expect(repo.list()).toHaveLength(1)
    expect(repo.get(original.id)).toMatchObject({
      fileName: 'kickflip final.mp4',
      sourcePath: renamed,
      projectId: skate.id,
      workflowStatus: 'ready',
      availability: 'online'
    })
    expect(events.some((e) => e.type === 'duplicate')).toBe(false)
  })

  it('detects duplicates imported in the same batch', async () => {
    const [mp4] = stage(fx.mp4)
    const copy = join(work, 'clip (1).mp4')
    copyFileSync(mp4!, copy)
    await service.importPaths([mp4!, copy])
    await service.waitForIdle()
    expect(repo.list()).toHaveLength(1)
  })

  it('marks moved files as missing and relinks them by file or by folder', async () => {
    const [mp4, mov] = stage(fx.mp4, fx.mov)
    await service.importPaths([mp4!, mov!])
    await service.waitForIdle()

    const moved = join(work, 'moved')
    mkdirSync(moved)
    renameSync(mp4!, join(moved, 'clip.mp4'))
    renameSync(mov!, join(moved, 'clip.mov'))
    expect(await service.checkAvailability()).toEqual({ missing: 2 })
    expect(byName('clip.mp4').availability).toBe('missing')
    // Metadata and thumbnail survive while the file is missing.
    expect(byName('clip.mp4')).toMatchObject({ status: 'ready', width: 320, hasThumbnail: true })

    const single = await service.relink(byName('clip.mp4').id, join(moved, 'clip.mp4'))
    expect(single).toMatchObject({ status: 'relinked', reprocessing: false })
    expect(byName('clip.mp4')).toMatchObject({ availability: 'online', sourcePath: join(moved, 'clip.mp4') })

    const folder = await service.relinkFromFolder(work)
    expect(folder).toMatchObject({ relinked: 1, stillMissing: 0 })
    expect(byName('clip.mov').availability).toBe('online')
    expect(await service.checkAvailability()).toEqual({ missing: 0 })
  })

  it('asks for confirmation before relinking to a file with different content', async () => {
    const [mp4, other] = stage(fx.mp4, fx.otherMp4)
    await service.importPaths([mp4!])
    await service.waitForIdle()
    rmSync(mp4!)
    await service.checkAvailability()
    const id = byName('clip.mp4').id

    const result = await service.relink(id, other!)
    expect(result).toEqual({ status: 'mismatch', fileName: 'other.mp4' })
    expect(repo.get(id).availability).toBe('missing')

    const confirmed = await service.confirmRelink(id)
    expect(confirmed).toMatchObject({ status: 'relinked', reprocessing: true })
    await service.waitForIdle()
    expect(repo.get(id)).toMatchObject({ fileName: 'other.mp4', audioCodec: null, status: 'ready', availability: 'online' })
  })

  it('refuses to relink to a file that is already in the library', async () => {
    const [mp4, mov] = stage(fx.mp4, fx.mov)
    await service.importPaths([mp4!, mov!])
    await service.waitForIdle()
    await expect(service.relink(byName('clip.mp4').id, mov!)).rejects.toThrow(/já está na biblioteca/)
  })

  it('removes a content without touching the source file', async () => {
    const [mp4, mov] = stage(fx.mp4, fx.mov)
    await service.importPaths([mp4!, mov!])
    await service.waitForIdle()

    const video = byName('clip.mp4')
    await service.remove(video.id)
    await service.remove(byName('clip.mov').id)
    expect(repo.list()).toEqual([])
    expect(existsSync(mp4!)).toBe(true)
    expect(existsSync(mov!)).toBe(true)
    expect(existsSync(join(thumbs, `${video.id}.jpg`))).toBe(false)
  })

  it('cancels queued and running imports', async () => {
    const files = stage(fx.mp4, fx.mov, fx.vertical, fx.rotatedMp4, fx.otherMp4)
    await service.importPaths(files)
    // Wait until FFmpeg work is actually running, so both paths (queued and running) are exercised.
    await waitFor(() => service.queueState().current.length > 0)
    expect(service.queueState().current.length).toBeGreaterThan(0)
    await service.cancelAll()
    await service.waitForIdle()
    expect(repo.list()).toEqual([])
    expect(readdirSync(temp)).toEqual([])
    expect(files.every((f) => existsSync(f))).toBe(true)
  })

  it('resumes imports interrupted by a crash', async () => {
    const [vertical, mov] = stage(fx.vertical, fx.mov)
    // Simulate a crash mid-import: rows left in 'pending' / 'processing'.
    const a = repo.insertPending({ path: vertical!, pathKey: vertical!, size: 1, mtimeMs: 0 })!
    const b = repo.insertPending({ path: mov!, pathKey: mov!, size: 1, mtimeMs: 0 })!
    repo.markProcessing(b.id)

    service.start()
    await service.waitForIdle()
    expect(repo.get(a.id).status).toBe('ready')
    expect(repo.get(b.id)).toMatchObject({ status: 'ready', kind: 'video', hasThumbnail: true })
  })

  it('fails fast when FFmpeg is unavailable, then resumes pending work once it is back', async () => {
    available = false
    await expect(service.importPaths(stage(fx.mp4))).rejects.toThrow(UnavailableError)
    expect(repo.list()).toEqual([])

    // Work left pending from an earlier session stays pending while FFmpeg is missing...
    const [mov] = stage(fx.mov)
    const pending = repo.insertPending({ path: mov!, pathKey: mov!, size: 1, mtimeMs: 0 })!
    service.start()
    await service.waitForIdle()
    expect(repo.get(pending.id).status).toBe('pending')

    // ...and is processed after FFmpeg is fixed.
    available = true
    service.resume()
    await service.waitForIdle()
    expect(repo.get(pending.id).status).toBe('ready')
  })

  it('reports a file deleted between selection and processing', async () => {
    const [mp4] = stage(fx.mp4)
    const asset = repo.insertPending({ path: mp4!, pathKey: mp4!, size: 1, mtimeMs: 0 })!
    rmSync(mp4!)
    service.start()
    await service.waitForIdle()
    expect(repo.get(asset.id)).toMatchObject({ status: 'error', availability: 'missing' })
    expect(repo.get(asset.id).errorMessage).toContain('movido ou apagado')
  })

  it('retries a failed import, and re-importing a changed failed file queues it again', async () => {
    const [mp4] = stage(fx.mp4)
    const broken = join(work, 'later.mp4')
    writeFileSync(broken, 'not yet')
    await service.importPaths([broken])
    await service.waitForIdle()
    expect(byName('later.mp4').status).toBe('error')

    copyFileSync(mp4!, broken)
    service.retry(byName('later.mp4').id)
    await service.waitForIdle()
    expect(byName('later.mp4').status).toBe('ready')

    // Same path imported again after it failed: queued again (used by folder watching).
    const second = join(work, 'second.mp4')
    writeFileSync(second, 'partial')
    await service.importPaths([second])
    await service.waitForIdle()
    expect(byName('second.mp4').status).toBe('error')
    copyFileSync(fx.vertical, second)
    const again = await service.importPaths([second])
    expect(again).toMatchObject({ queued: 0, alreadyInLibrary: 1 })
    await service.waitForIdle()
    expect(byName('second.mp4')).toMatchObject({ status: 'ready', width: 180 })
  })
})

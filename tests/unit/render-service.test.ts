import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContentVersion, EditSettings, VersionEvent } from '../../src/shared/editor'
import { defaultEditSettings, newTextOverlay } from '../../src/shared/editor'
import { CreateProjectInputSchema } from '../../src/shared/schemas'
import { runMigrations } from '../../src/main/db/migrations'
import type { SqlDriver } from '../../src/main/db/driver'
import { EncoderSelector, H264_ENCODERS } from '../../src/main/editor/encoders'
import { RenderService } from '../../src/main/editor/render-service'
import { ImportService } from '../../src/main/media/import-service'
import { ContentsRepository } from '../../src/main/repositories/contents'
import { PresetsRepository } from '../../src/main/repositories/presets'
import { ProjectsRepository } from '../../src/main/repositories/projects'
import { VersionsRepository } from '../../src/main/repositories/versions'
import { createFixtures, testTools, type Fixtures } from '../helpers/media'
import { createNodeSqliteDriver, memoryLogger, tempDir } from '../helpers/node-sqlite-driver'
import { overlayPng } from '../helpers/png'

const tools = testTools()

/** RGB of one output pixel at time `t`. */
function pixel(file: string, t: number, x: number, y: number): [number, number, number] {
  const out = execFileSync(
    tools!.ffmpeg,
    // 2×2 at even coordinates: 4:2:0 video can't be cropped to a single pixel.
    ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${x - (x % 2)}:${y - (y % 2)}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1024 }
  )
  return [out[0]!, out[1]!, out[2]!]
}

function probe(file: string): { width: number; height: number; duration: number; codec: string; audio: boolean } {
  const out = JSON.parse(
    execFileSync(tools!.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' })
  ) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number }[]; format: { duration: string } }
  const video = out.streams.find((s) => s.codec_type === 'video')!
  return {
    width: video.width!,
    height: video.height!,
    duration: Number(out.format.duration),
    codec: video.codec_name,
    audio: out.streams.some((s) => s.codec_type === 'audio')
  }
}

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

describe.skipIf(!tools)('RenderService with real FFmpeg', () => {
  const root = tempDir('sm-render-')
  let fx: Fixtures
  let db: SqlDriver
  let contents: ContentsRepository
  let versions: VersionsRepository
  let projects: ProjectsRepository
  let importer: ImportService
  let renderer: RenderService
  let events: VersionEvent[]
  let work: string
  let exportsDir: string
  let created: string[]

  const makeRenderer = () =>
    new RenderService({
      versions,
      contents,
      projectName: (id) => (id ? projects.get(id).name : null),
      getTools: async () => ({ ffmpeg: tools!.ffmpeg, ffprobe: tools!.ffprobe }),
      // Software only in tests: deterministic on every CI machine.
      encoders: new EncoderSelector(async () => ({ ffmpeg: tools!.ffmpeg, ffprobe: tools!.ffprobe }), memoryLogger()),
      encoderPreference: () => 'software',
      exportsDirectory: () => exportsDir,
      versionsDirectory: join(work, 'app-data', 'versions'),
      thumbnailsDirectory: join(work, 'app-data', 'thumbnails'),
      tempDirectory: join(work, 'app-data', 'temp'),
      logger: memoryLogger(),
      emit: (e) => events.push(e),
      onVersionCreated: (id) => created.push(id)
    })

  beforeAll(() => {
    fx = createFixtures(tools!, join(root.path, 'fixtures'))
  })
  afterAll(() => root.cleanup())

  beforeEach(() => {
    work = join(root.path, `w-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    exportsDir = join(work, 'exports')
    for (const d of ['footage', 'app-data/thumbnails', 'app-data/temp', 'app-data/versions']) mkdirSync(join(work, d), { recursive: true })
    db = createNodeSqliteDriver()
    runMigrations(db)
    contents = new ContentsRepository(db)
    versions = new VersionsRepository(db)
    projects = new ProjectsRepository(db)
    events = []
    created = []
    importer = new ImportService({
      repo: contents,
      getTools: async () => ({ ffmpeg: tools!.ffmpeg, ffprobe: tools!.ffprobe }),
      thumbnailsDirectory: join(work, 'app-data', 'thumbnails'),
      tempDirectory: join(work, 'app-data', 'temp'),
      logger: memoryLogger(),
      emit: () => {}
    })
    renderer = makeRenderer()
  })
  afterEach(() => {
    renderer.shutdown()
    importer.shutdown()
    db.close()
  })

  async function importClip(fixture: string, name: string, projectId: string | null = null) {
    const path = join(work, 'footage', name)
    copyFileSync(fixture, path)
    await importer.importPaths([path], { projectId })
    await importer.waitForIdle()
    const content = contents.list().find((c) => c.fileName === name)!
    expect(content.status).toBe('ready')
    return { content, path }
  }

  const finished = async (id: string): Promise<ContentVersion> => {
    await renderer.waitForIdle()
    return versions.get(id)
  }

  it('exports a 9:16 version with trim and a text overlay, leaving the original untouched', async () => {
    const mma = projects.create(CreateProjectInputSchema.parse({ name: 'MMA' }))
    const { content, path } = await importClip(fx.mp4, 'KO round 1.mp4', mma.id)
    const originalHash = sha(path)

    const text = newTextOverlay('title')
    const settings: EditSettings = { ...defaultEditSettings(), trim: { start: 0.5, end: 1.5 }, texts: [text] }
    const version = await renderer.create({
      contentId: content.id,
      name: 'Clean 9:16',
      settings,
      overlays: [{ textId: 'title', png: overlayPng(1080, 1920, { x: 0.25, y: 0.1, w: 0.5, h: 0.08 }) }]
    })
    expect(version.status).toBe('rendering')
    expect(created).toEqual([content.id])

    const done = await finished(version.id)
    expect(done).toMatchObject({ status: 'ready', progress: 1, width: 1080, height: 1920, aspectRatio: '9:16', encoder: 'libopenh264', hasThumbnail: true })
    // Project subfolder; ":" isn't allowed in Windows file names.
    expect(done.filePath).toBe(join(exportsDir, 'MMA', 'KO round 1 - Clean 9 16.mp4'))
    expect(existsSync(done.filePath!)).toBe(true)
    expect(existsSync(done.filePath + '.part')).toBe(false)

    const info = probe(done.filePath!)
    expect(info).toMatchObject({ width: 1080, height: 1920, codec: 'h264', audio: true })
    expect(info.duration).toBeGreaterThan(0.9)
    expect(info.duration).toBeLessThan(1.15)

    // The text overlay is burned in where the image had it (red box centred at 50 %, 14 %).
    const [r, g, b] = pixel(done.filePath!, 0.5, 540, Math.round(1920 * 0.14))
    expect(r).toBeGreaterThan(200)
    expect(g).toBeLessThan(60)
    expect(b).toBeLessThan(60)

    // The original was only read.
    expect(sha(path)).toBe(originalHash)
    expect(events.some((e) => e.type === 'version' && e.version.status === 'ready')).toBe(true)
  })

  it('shows the whole picture on a black background with "contain", and can mute the audio', async () => {
    const { content } = await importClip(fx.mp4, 'wide.mp4')
    const settings: EditSettings = {
      ...defaultEditSettings(),
      frame: { fit: 'contain', zoom: 1, x: 0, y: 0, background: 'black' },
      audio: { mute: true }
    }
    const v = await renderer.create({ contentId: content.id, name: 'Contain', settings, overlays: [] })
    const done = await finished(v.id)
    expect(done.status).toBe('ready')
    const info = probe(done.filePath!)
    expect(info.audio).toBe(false)
    // Top area is black; the picture sits in the middle.
    const top = pixel(done.filePath!, 0.5, 540, 100)
    expect(Math.max(...top)).toBeLessThan(30)
  })

  it('exports in the original format and with a blurred background', async () => {
    const { content } = await importClip(fx.vertical, 'vertical.mp4')
    const original = await renderer.create({
      contentId: content.id,
      name: 'Original',
      settings: { ...defaultEditSettings(), output: { preset: 'original' } },
      overlays: []
    })
    const blurred = await renderer.create({
      contentId: content.id,
      name: 'Feed 16x9',
      settings: { ...defaultEditSettings(), output: { preset: '16:9' }, frame: { fit: 'contain', zoom: 1, x: 0, y: 0, background: 'blur' } },
      overlays: []
    })
    expect((await finished(original.id))).toMatchObject({ status: 'ready', width: 180, height: 320 })
    expect(versions.get(blurred.id)).toMatchObject({ status: 'ready', width: 1920, height: 1080, aspectRatio: '16:9' })
  })

  it('rejects impossible requests before rendering', async () => {
    const { content } = await importClip(fx.mp4, 'clip.mp4')
    const base = { contentId: content.id, overlays: [] as { textId: string; png: Uint8Array }[] }
    await expect(
      renderer.create({ ...base, name: 'Late', settings: { ...defaultEditSettings(), trim: { start: 5, end: null } } })
    ).rejects.toThrow(/depois do fim/)

    const withText = { ...defaultEditSettings(), texts: [newTextOverlay('t')] }
    await expect(
      renderer.create({ ...base, name: 'Bad overlay', settings: withText, overlays: [{ textId: 't', png: overlayPng(100, 100) }] })
    ).rejects.toThrow(/tamanho do vídeo final/)
    await expect(
      renderer.create({ ...base, name: 'Orphan', settings: defaultEditSettings(), overlays: [{ textId: 'x', png: overlayPng(1080, 1920) }] })
    ).rejects.toThrow(/sem texto correspondente/)

    await renderer.create({ ...base, name: 'Final', settings: defaultEditSettings() })
    await expect(renderer.create({ ...base, name: 'final', settings: defaultEditSettings() })).rejects.toThrow(/Já existe uma versão/)
    await renderer.waitForIdle()
    expect(versions.listForContent(content.id)).toHaveLength(1)
  })

  it('never overwrites an existing file in the export folder', async () => {
    const { content } = await importClip(fx.mp4, 'gol.mp4')
    const folder = join(exportsDir, 'Sem projeto')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'gol - A.mp4'), 'user file')
    const v = await renderer.create({ contentId: content.id, name: 'A', settings: defaultEditSettings(), overlays: [] })
    const done = await finished(v.id)
    expect(done.filePath).toBe(join(folder, 'gol - A (2).mp4'))
    expect(readFileSync(join(folder, 'gol - A.mp4'), 'utf8')).toBe('user file')
  })

  it('cancels a running render and removes the unfinished version', async () => {
    const { content } = await importClip(fx.mp4, 'cancel.mp4')
    const v = await renderer.create({ contentId: content.id, name: 'Cancel me', settings: defaultEditSettings(), overlays: [] })
    await renderer.cancel(v.id)
    await renderer.waitForIdle()
    expect(versions.find(v.id)).toBeNull()
    expect(existsSync(v.filePath!)).toBe(false)
    expect(existsSync(v.filePath! + '.part')).toBe(false)
    expect(events).toContainEqual({ type: 'version-removed', id: v.id, contentId: content.id })
  })

  it('marks renders interrupted by a quit as failed, and retries them', async () => {
    const { content } = await importClip(fx.mp4, 'retry.mp4')
    const v = await renderer.create({
      contentId: content.id,
      name: 'Interrupted',
      settings: { ...defaultEditSettings(), texts: [newTextOverlay('t')] },
      overlays: [{ textId: 't', png: overlayPng(1080, 1920) }]
    })
    renderer.shutdown()
    await new Promise((r) => setTimeout(r, 300))

    renderer = makeRenderer()
    await renderer.start()
    expect(versions.get(v.id)).toMatchObject({ status: 'error' })
    expect(versions.get(v.id).errorMessage).toContain('interrompida')

    renderer.retry(v.id)
    const done = await finished(v.id)
    expect(done.status).toBe('ready')
    expect(readdirSync(join(exportsDir, 'Sem projeto')).filter((f) => f.endsWith('.part'))).toEqual([])
  })

  it('deletes a version, keeping its file unless asked', async () => {
    const { content } = await importClip(fx.mp4, 'del.mp4')
    const a = await renderer.create({ contentId: content.id, name: 'Keep file', settings: defaultEditSettings(), overlays: [] })
    const b = await renderer.create({ contentId: content.id, name: 'Delete file', settings: defaultEditSettings(), overlays: [] })
    await renderer.waitForIdle()
    const fileA = versions.get(a.id).filePath!
    const fileB = versions.get(b.id).filePath!

    await renderer.remove(a.id, false)
    await renderer.remove(b.id, true)
    expect(versions.listForContent(content.id)).toEqual([])
    expect(existsSync(fileA)).toBe(true)
    expect(existsSync(fileB)).toBe(false)
    expect(existsSync(join(work, 'app-data', 'versions', a.id))).toBe(false)
  })

  it('refuses to export while the original file is missing', async () => {
    const { content, path } = await importClip(fx.mp4, 'gone.mp4')
    rmSync(path)
    await importer.checkAvailability()
    await expect(
      renderer.create({ contentId: content.id, name: 'X', settings: defaultEditSettings(), overlays: [] })
    ).rejects.toThrow(/não foi encontrado/)
  })

  it('detects a working H.264 encoder (OpenH264 at least)', async () => {
    const selector = new EncoderSelector(async () => ({ ffmpeg: tools!.ffmpeg, ffprobe: tools!.ffprobe }), memoryLogger())
    const chosen = await selector.select('auto')
    expect(H264_ENCODERS.map((e) => e.id)).toContain(chosen.id)
    expect((await selector.select('software')).id).toBe('libopenh264')
  })

  it('saves presets per project and globally, replacing by name', () => {
    const presets = new PresetsRepository(db)
    const p = projects.create(CreateProjectInputSchema.parse({ name: 'Skate' }))
    const { trim: _t, ...style } = { ...defaultEditSettings(), texts: [newTextOverlay('t', { fontFamily: 'Anton' })] }
    presets.save({ projectId: p.id, name: 'Título amarelo', settings: style })
    presets.save({ projectId: null, name: 'Limpo', settings: { ...style, texts: [] } })
    const replaced = presets.save({ projectId: p.id, name: 'título amarelo', settings: { ...style, output: { preset: '1:1' } } })
    expect(presets.list(p.id).map((x) => x.name)).toEqual(['título amarelo', 'Limpo'])
    expect(presets.get(replaced.id).settings.output.preset).toBe('1:1')
    expect(presets.list(null).map((x) => x.name)).toEqual(['Limpo'])
    presets.delete(replaced.id)
    expect(presets.list(p.id)).toHaveLength(1)
  })
})

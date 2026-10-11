import { existsSync } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path'
import {
  aspectRatioLabel,
  type ContentItem
} from '../../shared/media'
import {
  MAX_OVERLAY_BYTES,
  outputSize,
  validateEdit,
  type ContentVersion,
  type EditSettings,
  type EncoderInfo,
  type VersionEvent
} from '../../shared/editor'
import { ConflictError, UnprocessableError } from '../errors'
import type { Logger } from '../logger'
import type { MediaTools } from '../media/binaries'
import { createThumbnail } from '../media/operations'
import { runProbe } from '../media/probe'
import { ProcessError, runProcess } from '../media/run-process'
import type { AssetRecord, ContentsRepository } from '../repositories/contents'
import type { VersionsRepository } from '../repositories/versions'
import type { EncoderSelector } from './encoders'
import { SOFTWARE_ENCODER } from './encoders'
import { buildRenderPlan, progressFromLine } from './render-plan'

export type RenderServiceOptions = {
  versions: VersionsRepository
  contents: ContentsRepository
  /** Project name for the output subfolder, or null for "Sem projeto". */
  projectName: (projectId: string | null) => string | null
  getTools: () => Promise<MediaTools>
  encoders: EncoderSelector
  encoderPreference: () => 'auto' | 'software'
  /** Where finished versions are written (one subfolder per project). */
  exportsDirectory: () => string
  /** App-owned folder for per-version working files (text overlay images). */
  versionsDirectory: string
  thumbnailsDirectory: string
  tempDirectory: string
  logger: Logger
  emit: (event: VersionEvent) => void
  /** Called after a version was created, e.g. to move the content to "editing". */
  onVersionCreated?: (contentId: string) => void
}

export type CreateVersionInput = {
  contentId: string
  name: string
  settings: EditSettings
  overlays: { textId: string; png: Uint8Array }[]
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PART_SUFFIX = '.part'

/** Width and height from a PNG's IHDR chunk, or null if it isn't a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** A file or folder name safe on Windows: no reserved characters, no trailing dots/spaces, bounded length. */
export function safeFileName(name: string, fallback = 'video'): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 90)
    .trim()
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i
  return cleaned && !reserved.test(cleaned) ? cleaned : fallback
}

/**
 * Renders edited versions with FFmpeg, one at a time, in the background.
 *
 * The original file is only read. Output is written to "<name>.mp4.part"
 * and renamed when FFmpeg finishes and the result has been verified with
 * FFprobe, so an interrupted render never leaves a file that looks complete
 * (and a watched folder pointing at the export folder ignores ".part").
 */
export class RenderService {
  private readonly queue: string[] = []
  private active: { id: string; controller: AbortController } | null = null
  private readonly cancelled = new Set<string>()
  private pumping = false
  private shuttingDown = false
  private idleWaiters: (() => void)[] = []

  constructor(private readonly options: RenderServiceOptions) {}

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  /** Renders interrupted by a crash or quit are marked as failed; the user can retry them. */
  async start(): Promise<void> {
    for (const id of this.options.versions.renderingIds()) {
      const version = this.options.versions.markError(id, 'A exportação foi interrompida (o app foi fechado). Use “Tentar de novo”.')
      if (version.filePath) await rm(version.filePath + PART_SUFFIX, { force: true }).catch(() => undefined)
      this.emit({ type: 'version', version })
    }
  }

  shutdown(): void {
    this.shuttingDown = true
    this.queue.length = 0
    this.active?.controller.abort()
  }

  waitForIdle(): Promise<void> {
    if (!this.active && this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  /* ---------------------------------------------------------------- */
  /* Commands                                                         */
  /* ---------------------------------------------------------------- */

  async create(input: CreateVersionInput): Promise<ContentVersion> {
    const content = this.options.contents.record(input.contentId)
    this.assertRenderable(content)

    const problems = validateEdit(input.settings, content.durationSeconds!)
    if (problems.length) throw new UnprocessableError(problems.join(' '))

    const expected = outputSize(input.settings.output.preset, { width: content.width!, height: content.height! })
    const textIds = new Set(input.settings.texts.map((t) => t.id))
    for (const overlay of input.overlays) {
      if (!textIds.has(overlay.textId)) throw new UnprocessableError('Imagem de texto sem texto correspondente.')
      if (overlay.png.byteLength > MAX_OVERLAY_BYTES) throw new UnprocessableError('A imagem de um texto é grande demais.')
      const size = pngSize(overlay.png)
      if (!size || size.width !== expected.width || size.height !== expected.height) {
        throw new UnprocessableError('A imagem de um texto não tem o tamanho do vídeo final. Tente exportar de novo.')
      }
    }

    const name = input.name.trim()
    if (this.options.versions.namesFor(content.id).has(name.toLowerCase())) {
      throw new ConflictError(`Já existe uma versão chamada “${name}” para este conteúdo.`)
    }

    const outputPath = await this.uniqueOutputPath(content, name)
    const version = this.options.versions.createRendering({
      contentId: content.id,
      name,
      settings: input.settings,
      filePath: outputPath
    })
    try {
      const dir = this.overlayDirectory(version.id)
      await mkdir(dir, { recursive: true })
      for (const overlay of input.overlays) await writeFile(join(dir, `text-${safeId(overlay.textId)}.png`), overlay.png)
    } catch (error) {
      this.options.versions.markError(version.id, `Não foi possível preparar os textos: ${(error as Error).message}`)
      this.emitVersion(version.id)
      throw error
    }

    this.options.logger.info('Version queued', { id: version.id, content: content.id, output: outputPath })
    this.options.onVersionCreated?.(content.id)
    this.emitVersion(version.id)
    this.enqueue(version.id)
    return this.options.versions.get(version.id)
  }

  retry(id: string): ContentVersion {
    const version = this.options.versions.get(id)
    if (version.status !== 'error') throw new ConflictError('Só é possível tentar de novo uma exportação que falhou.')
    this.assertRenderable(this.options.contents.record(version.contentId))
    const updated = this.options.versions.setRendering(id)
    this.emit({ type: 'version', version: updated })
    this.enqueue(id)
    return updated
  }

  /** Cancels a queued or running render; the unfinished version is removed. */
  async cancel(id: string): Promise<void> {
    if (this.active?.id === id) {
      this.cancelled.add(id)
      this.active.controller.abort()
      return
    }
    const index = this.queue.indexOf(id)
    if (index >= 0) this.queue.splice(index, 1)
    const version = this.options.versions.get(id)
    if (version.status !== 'rendering') throw new ConflictError('Essa versão não está sendo exportada.')
    await this.discard(id, true)
  }

  /** Deletes a version. Its exported file is deleted only when asked. */
  async remove(id: string, deleteFile: boolean): Promise<void> {
    const version = this.options.versions.get(id)
    if (version.status === 'rendering') throw new ConflictError('Cancele a exportação antes de excluir a versão.')
    if (this.options.versions.isPublished(id)) {
      throw new ConflictError('Essa versão já foi usada numa publicação e não pode ser excluída.')
    }
    await this.discard(id, deleteFile)
    this.options.logger.info('Version removed', { id, deleteFile })
  }

  /* ---------------------------------------------------------------- */
  /* Queue                                                            */
  /* ---------------------------------------------------------------- */

  private enqueue(id: string): void {
    if (this.queue.includes(id) || this.active?.id === id) return
    this.queue.push(id)
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (!this.shuttingDown && !this.active && this.queue.length) {
        const id = this.queue.shift()!
        await this.run(id)
      }
    } finally {
      this.pumping = false
    }
    if (!this.active && this.queue.length === 0) {
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  private async run(id: string): Promise<void> {
    const version = this.options.versions.find(id)
    if (!version || version.status !== 'rendering') return
    const controller = new AbortController()
    this.active = { id, controller }
    try {
      await this.render(version, controller.signal)
    } catch (error) {
      if (this.shuttingDown) return // stays "rendering"; marked as interrupted on next start
      if (this.cancelled.delete(id)) {
        await this.discard(id, true)
        this.options.logger.info('Version cancelled', { id })
      } else {
        const message = this.describeFailure(error)
        this.options.logger.warn('Version render failed', { id, message, error })
        if (version.filePath) await rm(version.filePath + PART_SUFFIX, { force: true }).catch(() => undefined)
        try {
          this.options.versions.markError(id, message)
          this.emitVersion(id)
        } catch {
          // Removed meanwhile.
        }
      }
    } finally {
      this.active = null
    }
  }

  private async render(version: ContentVersion, signal: AbortSignal): Promise<void> {
    const tools = await this.options.getTools()
    const content = this.options.contents.record(version.contentId)
    this.assertRenderable(content)
    if (!version.filePath) throw new UnprocessableError('A versão não tem um caminho de saída.')

    const dir = this.overlayDirectory(version.id)
    const overlays = version.settings.texts
      .map((t) => ({ textId: t.id, path: join(dir, `text-${safeId(t.id)}.png`) }))
      .filter((o) => existsSync(o.path))

    const source = {
      path: content.sourcePath,
      width: content.width!,
      height: content.height!,
      durationSeconds: content.durationSeconds!,
      frameRate: content.frameRate,
      hasAudio: content.audioCodec !== null
    }
    const part = version.filePath + PART_SUFFIX
    await mkdir(dirname(version.filePath), { recursive: true })

    let encoder: EncoderInfo = await this.options.encoders.select(this.options.encoderPreference())
    const attempt = async (enc: EncoderInfo) => {
      const plan = buildRenderPlan({ source, settings: version.settings, overlays, encoder: enc.id, outputPath: part })
      let lastReported = 0
      await runProcess(tools.ffmpeg, plan.args, {
        signal,
        // Generous: software encoding of long clips on slow machines.
        timeoutMs: Math.max(10 * 60_000, plan.durationSeconds * 20_000),
        onStdoutLine: (line) => {
          const progress = progressFromLine(line, plan.durationSeconds)
          if (progress === null || progress - lastReported < 0.02) return
          lastReported = progress
          this.options.versions.setProgress(version.id, progress * 0.95)
          this.emitVersion(version.id)
        }
      })
      return plan
    }

    let plan
    try {
      plan = await attempt(encoder)
    } catch (error) {
      // A hardware encoder can pass the quick test and still fail on real content (driver, resolution limits).
      if (signal.aborted || !encoder.hardware || !(error instanceof ProcessError) || error.code !== 'EXIT') throw error
      this.options.logger.warn('Hardware encoder failed; retrying with OpenH264', { encoder: encoder.id, error })
      encoder = SOFTWARE_ENCODER
      plan = await attempt(encoder)
    }

    // Verify the result before calling it done.
    const { interpretation } = await runProbe(tools, part, basename(version.filePath), signal)
    if (!interpretation.ok) throw new UnprocessableError(`O arquivo exportado não pôde ser lido: ${interpretation.message}`)
    const meta = interpretation.metadata
    if (!meta.video || meta.video.width !== plan.width || meta.video.height !== plan.height) {
      throw new UnprocessableError(
        `O arquivo exportado tem tamanho inesperado (${meta.video?.width}×${meta.video?.height}, esperado ${plan.width}×${plan.height}).`
      )
    }
    if (Math.abs(meta.durationSeconds - plan.durationSeconds) > Math.max(0.5, plan.durationSeconds * 0.05)) {
      throw new UnprocessableError(
        `O arquivo exportado tem duração inesperada (${meta.durationSeconds.toFixed(1)} s, esperado ${plan.durationSeconds.toFixed(1)} s).`
      )
    }

    await rm(version.filePath, { force: true })
    await rename(part, version.filePath)
    const info = await stat(version.filePath)

    let thumbnailPath: string | null = join(this.options.thumbnailsDirectory, `version-${version.id}.jpg`)
    try {
      await createThumbnail(tools, version.filePath, basename(version.filePath), meta, thumbnailPath, this.options.tempDirectory, signal)
    } catch (error) {
      this.options.logger.warn('Version thumbnail failed', { id: version.id, error })
      thumbnailPath = null
    }

    this.options.versions.markReady(version.id, {
      fileSize: info.size,
      durationSeconds: meta.durationSeconds,
      width: plan.width,
      height: plan.height,
      aspectRatio: aspectRatioLabel(plan.width, plan.height),
      encoder: encoder.id,
      thumbnailPath
    })
    this.options.logger.info('Version rendered', { id: version.id, encoder: encoder.id, file: version.filePath })
    this.emitVersion(version.id)
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                          */
  /* ---------------------------------------------------------------- */

  private assertRenderable(content: AssetRecord | ContentItem): void {
    if (content.status !== 'ready' || !content.width || !content.height || !content.durationSeconds) {
      throw new ConflictError('Esse vídeo ainda não terminou de ser importado.')
    }
    if (content.availability === 'missing') {
      throw new ConflictError('O arquivo original não foi encontrado. Localize-o na Biblioteca antes de exportar.')
    }
  }

  private overlayDirectory(versionId: string): string {
    return join(this.options.versionsDirectory, versionId)
  }

  private async uniqueOutputPath(content: AssetRecord, versionName: string): Promise<string> {
    const folder = join(
      this.options.exportsDirectory(),
      safeFileName(this.options.projectName(content.projectId) ?? 'Sem projeto', 'Sem projeto')
    )
    const base = safeFileName(content.title ?? basename(content.fileName, extname(content.fileName)))
    const stem = `${base} - ${safeFileName(versionName, 'versao')}`
    for (let n = 1; n < 1000; n++) {
      const candidate = join(folder, `${stem}${n === 1 ? '' : ` (${n})`}.mp4`)
      if (!existsSync(candidate) && !existsSync(candidate + PART_SUFFIX)) return candidate
    }
    throw new ConflictError('Não foi possível escolher um nome de arquivo livre para a versão.')
  }

  private async discard(id: string, deleteFile: boolean): Promise<void> {
    let record
    try {
      record = this.options.versions.record(id)
    } catch {
      return
    }
    this.options.versions.delete(id)
    await rm(this.overlayDirectory(id), { recursive: true, force: true }).catch(() => undefined)
    if (record.thumbnailPath && isInside(this.options.thumbnailsDirectory, record.thumbnailPath)) {
      await rm(record.thumbnailPath, { force: true }).catch(() => undefined)
    }
    if (record.filePath) {
      await rm(record.filePath + PART_SUFFIX, { force: true }).catch(() => undefined)
      if (deleteFile) await rm(record.filePath, { force: true }).catch(() => undefined)
    }
    this.emit({ type: 'version-removed', id, contentId: record.contentId })
  }

  private describeFailure(error: unknown): string {
    if (error instanceof UnprocessableError || error instanceof ConflictError) return error.message
    if (error instanceof ProcessError) {
      if (error.code === 'TIMEOUT') return 'A exportação demorou demais e foi interrompida.'
      if (error.code === 'SPAWN') return `Não foi possível iniciar o FFmpeg (${error.message}).`
      return `O FFmpeg falhou ao exportar.${error.stderrSummary ? ` (${error.stderrSummary})` : ''}`
    }
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'EACCES' || code === 'EPERM') return 'Sem permissão para gravar na pasta de exportação.'
    if (code === 'ENOSPC') return 'Não há espaço livre suficiente no disco.'
    return `A exportação falhou: ${(error as Error)?.message ?? String(error)}`
  }

  private emitVersion(id: string): void {
    const version = this.options.versions.find(id)
    if (version) this.emit({ type: 'version', version })
  }

  private emit(event: VersionEvent): void {
    try {
      this.options.emit(event)
    } catch (error) {
      this.options.logger.warn('Version event delivery failed', { error })
    }
  }
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function isInside(folder: string, path: string): boolean {
  const rel = relative(folder, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

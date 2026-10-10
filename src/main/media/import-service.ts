import { rm, stat } from 'node:fs/promises'
import { basename, join, relative, isAbsolute } from 'node:path'
import type {
  ImportOptions,
  ImportQueueState,
  ImportSummary,
  ContentItem,
  MediaEvent,
  RelinkFolderResult,
  RelinkResult
} from '../../shared/media'
import { ConflictError, UnavailableError, UnprocessableError } from '../errors'
import type { Logger } from '../logger'
import type { AssetRecord, ContentsRepository } from '../repositories/contents'
import type { MediaTools } from './binaries'
import { collectImportCandidates, pathKey, quickFingerprint, VIDEO_EXTENSION_SET } from './files'
import { createThumbnail, verifyDecodable } from './operations'
import { MediaReadError, runProbe } from './probe'
import { ProcessError } from './run-process'

export type ImportServiceOptions = {
  repo: ContentsRepository
  /** Resolves verified FFmpeg paths, or throws UnavailableError with a user-facing message. */
  getTools: () => Promise<MediaTools>
  thumbnailsDirectory: string
  tempDirectory: string
  logger: Logger
  emit: (event: MediaEvent) => void
  /** Files analysed in parallel. Each runs at most one FFmpeg process at a time. */
  concurrency?: number
}

class DuplicateContentError extends Error {
  constructor(readonly existing: ContentItem) {
    super('duplicate')
  }
}

class SourceMissingError extends Error {}

class NotVideoError extends Error {}

class MovedContentError extends Error {
  constructor(
    readonly existing: ContentItem,
    readonly target: { path: string; size: number; contentHash: string }
  ) {
    super('moved')
  }
}

/**
 * Imports media into the library and keeps the library in sync with the
 * files on disk. All FFmpeg work runs in child processes; nothing here blocks
 * the main process. State lives in SQLite, so an interrupted import resumes
 * on the next start.
 */
export class ImportService {
  private readonly repo: ContentsRepository
  private readonly logger: Logger
  private readonly concurrency: number

  private queue: string[] = []
  private readonly active = new Map<string, { controller: AbortController; fileName: string }>()
  private readonly cancelled = new Set<string>()
  /** Content hashes being imported right now, to catch duplicates imported together. */
  private readonly claimedHashes = new Map<string, string>()
  private readonly pendingRelinks = new Map<string, string>()
  private batch = { total: 0, completed: 0, failed: 0 }
  private pumping = false
  private pumpAgain = false
  private shuttingDown = false
  private availabilityRun: Promise<{ missing: number }> | null = null
  private idleWaiters: (() => void)[] = []

  constructor(private readonly options: ImportServiceOptions) {
    this.repo = options.repo
    this.logger = options.logger
    this.concurrency = options.concurrency ?? 2
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  /** Requeues work interrupted by a crash or forced quit. */
  start(): void {
    const reset = this.repo.resetInterrupted()
    const pending = this.repo.pendingIds()
    if (reset || pending.length) this.logger.info('Resuming media import', { interrupted: reset, pending: pending.length })
    for (const id of pending) this.enqueue(id)
    void this.pump()
  }

  /** Stops running FFmpeg processes. Interrupted items stay queued for the next start. */
  shutdown(): void {
    this.shuttingDown = true
    this.queue = []
    for (const job of this.active.values()) job.controller.abort()
  }

  /** Resumes a queue that was paused because FFmpeg was unavailable. */
  resume(): void {
    for (const id of this.repo.pendingIds()) if (!this.queue.includes(id) && !this.active.has(id)) this.enqueue(id)
    void this.pump()
  }

  queueState(): ImportQueueState {
    return {
      active: this.queue.length > 0 || this.active.size > 0,
      total: this.batch.total,
      completed: this.batch.completed,
      failed: this.batch.failed,
      current: [...this.active.values()].map((j) => j.fileName)
    }
  }

  /** Resolves when nothing is queued or processing (used by tests). */
  waitForIdle(): Promise<void> {
    if (!this.queueState().active) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  /* ---------------------------------------------------------------- */
  /* Import                                                           */
  /* ---------------------------------------------------------------- */

  async importPaths(paths: readonly string[], options: ImportOptions = {}): Promise<ImportSummary> {
    // Fail fast with an actionable message instead of queueing work that can't run.
    await this.options.getTools()

    // Inside folders only video files are considered; explicitly chosen files are always probed.
    const scan = await collectImportCandidates(paths, { extensions: VIDEO_EXTENSION_SET })
    const summary: ImportSummary = {
      queued: 0,
      alreadyInLibrary: 0,
      skippedNonMedia: scan.skippedNonMedia,
      truncated: scan.truncated,
      errors: [...scan.errors]
    }

    for (const file of scan.files) {
      let info
      try {
        info = await stat(file)
      } catch (error) {
        summary.errors.push({ path: file, message: `Não foi possível ler “${basename(file)}”: ${(error as Error).message}` })
        continue
      }
      const key = pathKey(file)
      const asset = this.repo.insertPending({ path: file, pathKey: key, size: info.size, mtimeMs: info.mtimeMs, ...options })
      if (asset) {
        this.emit({ type: 'asset', asset })
        this.enqueue(asset.id)
        summary.queued++
        continue
      }

      summary.alreadyInLibrary++
      const existing = this.repo.findByPathKey(key)
      if (!existing) continue
      // The same path again: the file is evidently back, and a failed import gets another try.
      if (existing.availability === 'missing') this.emit({ type: 'asset', asset: this.repo.setAvailability(existing.id, 'online') })
      if (existing.status === 'error' && !this.isBusy(existing.id)) {
        this.repo.updateFileStats(existing.id, info.size, info.mtimeMs)
        this.emit({ type: 'asset', asset: this.repo.requeue(existing.id) })
        this.enqueue(existing.id)
      }
    }

    if (summary.truncated) this.logger.warn('Folder import truncated', { files: scan.files.length })
    this.logger.info('Import requested', { ...summary, errors: summary.errors.length })
    void this.pump()
    return summary
  }

  retry(id: string): ContentItem {
    const asset = this.repo.get(id)
    if (asset.status !== 'error') throw new ConflictError('Só é possível tentar de novo importações que falharam.')
    if (asset.availability === 'missing') throw new ConflictError('O arquivo não foi encontrado. Localize-o primeiro.')
    const queued = this.repo.requeue(id)
    this.emit({ type: 'asset', asset: queued })
    this.enqueue(id)
    void this.pump()
    return queued
  }

  /** Cancels an import in progress (the entry is removed). */
  async cancel(id: string): Promise<void> {
    const job = this.active.get(id)
    if (job) {
      this.cancelled.add(id)
      job.controller.abort()
      return
    }
    const index = this.queue.indexOf(id)
    if (index >= 0) {
      this.queue.splice(index, 1)
      this.batch.total = Math.max(0, this.batch.total - 1)
      await this.discard(id)
      this.afterChange()
      return
    }
    const asset = this.repo.get(id)
    if (asset.status === 'pending') {
      await this.discard(id)
      return
    }
    throw new ConflictError('Esse arquivo já terminou de ser importado.')
  }

  async cancelAll(): Promise<void> {
    const queued = this.queue
    this.queue = []
    this.batch.total = Math.max(0, this.batch.total - queued.length)
    for (const id of queued) await this.discard(id)
    for (const [id, job] of this.active) {
      this.cancelled.add(id)
      job.controller.abort()
    }
    this.afterChange()
  }

  /** Removes an asset from the library. The source file is never touched. */
  async remove(id: string): Promise<void> {
    if (this.isBusy(id)) {
      await this.cancel(id)
      return
    }
    this.repo.get(id)
    await this.discard(id)
  }

  /* ---------------------------------------------------------------- */
  /* Availability and relinking                                       */
  /* ---------------------------------------------------------------- */

  /** Marks assets whose source file is gone as missing (and found ones as online). */
  checkAvailability(): Promise<{ missing: number }> {
    if (this.availabilityRun) return this.availabilityRun
    this.availabilityRun = (async () => {
      let missing = 0
      const locations = this.repo.allLocations()
      await mapLimit(locations, 8, async (loc) => {
        const present = await isFile(loc.sourcePath)
        const next = present ? 'online' : 'missing'
        if (!present) missing++
        if (next !== loc.availability && !this.isBusy(loc.id)) {
          try {
            this.emit({ type: 'asset', asset: this.repo.setAvailability(loc.id, next) })
          } catch {
            // Removed meanwhile.
          }
        }
      })
      if (missing) this.logger.info('Missing media files', { missing })
      return { missing }
    })().finally(() => {
      this.availabilityRun = null
    })
    return this.availabilityRun
  }

  /** Points an asset at a file chosen by the user. */
  async relink(id: string, newPath: string): Promise<RelinkResult> {
    return this.applyRelink(id, newPath, false)
  }

  /** Completes a relink that reported a content mismatch, after the user confirmed it. */
  async confirmRelink(id: string): Promise<RelinkResult> {
    const path = this.pendingRelinks.get(id)
    if (!path) throw new ConflictError('Nenhuma localização aguarda confirmação. Escolha o arquivo de novo.')
    this.pendingRelinks.delete(id)
    return this.applyRelink(id, path, true)
  }

  private async applyRelink(id: string, newPath: string, force: boolean): Promise<RelinkResult> {
    const record = this.repo.record(id)
    if (this.isBusy(id)) throw new ConflictError('Espere esse arquivo terminar de ser importado.')
    if (!(await isFile(newPath))) throw new UnprocessableError(`“${basename(newPath)}” não é um arquivo.`)

    const key = pathKey(newPath)
    const other = this.repo.findByPathKey(key)
    if (other && other.id !== id) throw new ConflictError(`Esse arquivo já está na biblioteca como “${other.fileName}”.`)

    const info = await stat(newPath)
    const fingerprint = await quickFingerprint(newPath)
    const sameContent = record.contentHash !== null && fingerprint.hash === record.contentHash
    if (!sameContent && record.contentHash !== null && !force) {
      this.pendingRelinks.set(id, newPath)
      return { status: 'mismatch', fileName: basename(newPath) }
    }

    const reprocess = !sameContent || record.status !== 'ready'
    if (reprocess) await this.deleteThumbnail(record.thumbnailPath)
    const asset = this.repo.relink(
      id,
      { path: newPath, pathKey: key, size: info.size, mtimeMs: info.mtimeMs, contentHash: fingerprint.hash },
      reprocess
    )
    this.logger.info('Media relinked', { id, reprocess })
    this.emit({ type: 'asset', asset })
    if (reprocess) {
      this.enqueue(id)
      void this.pump()
    }
    return { status: 'relinked', asset, reprocessing: reprocess }
  }

  /**
   * Looks for every missing file inside a folder the user picked, matching by
   * file name and size, then confirming by content fingerprint.
   */
  async relinkFromFolder(directory: string): Promise<Extract<RelinkFolderResult, { cancelled: false }>> {
    const missing = this.repo.missingAssets().filter((a) => !this.isBusy(a.id))
    if (missing.length === 0) return { cancelled: false, relinked: 0, stillMissing: 0, scannedFiles: 0 }

    const scan = await collectImportCandidates([directory], { maxFiles: 50_000, extensions: VIDEO_EXTENSION_SET })
    const byName = new Map<string, string[]>()
    for (const file of scan.files) {
      const name = basename(file).toLowerCase()
      byName.set(name, [...(byName.get(name) ?? []), file])
    }

    let relinked = 0
    for (const asset of missing) {
      const found = await this.findMatch(asset, byName.get(asset.fileName.toLowerCase()) ?? [])
      if (!found) continue
      const reprocess = asset.status !== 'ready'
      const updated = this.repo.relink(asset.id, { ...found, pathKey: pathKey(found.path) }, reprocess)
      this.emit({ type: 'asset', asset: updated })
      if (reprocess) this.enqueue(asset.id)
      relinked++
    }
    if (relinked) void this.pump()
    this.logger.info('Relinked from folder', { relinked, stillMissing: missing.length - relinked, scanned: scan.files.length })
    return { cancelled: false, relinked, stillMissing: missing.length - relinked, scannedFiles: scan.files.length }
  }

  private async findMatch(
    asset: AssetRecord,
    candidates: string[]
  ): Promise<{ path: string; size: number; mtimeMs: number; contentHash: string } | null> {
    for (const path of candidates) {
      try {
        const info = await stat(path)
        if (info.size !== asset.fileSize) continue
        const other = this.repo.findByPathKey(pathKey(path))
        if (other && other.id !== asset.id) continue
        const fingerprint = await quickFingerprint(path)
        if (asset.contentHash !== null && fingerprint.hash !== asset.contentHash) continue
        return { path, size: info.size, mtimeMs: info.mtimeMs, contentHash: fingerprint.hash }
      } catch {
        // Unreadable candidate: keep looking.
      }
    }
    return null
  }

  /* ---------------------------------------------------------------- */
  /* Queue                                                            */
  /* ---------------------------------------------------------------- */

  private isBusy(id: string): boolean {
    return this.active.has(id) || this.queue.includes(id)
  }

  private enqueue(id: string): void {
    if (this.isBusy(id)) return
    this.queue.push(id)
    this.batch.total++
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true
      return
    }
    this.pumping = true
    try {
      do {
        this.pumpAgain = false
        while (!this.shuttingDown && this.active.size < this.concurrency && this.queue.length > 0) {
          let tools: MediaTools
          try {
            tools = await this.options.getTools()
          } catch (error) {
            // Leave items pending; resume() restarts the queue once FFmpeg works again.
            if (error instanceof UnavailableError) {
              this.logger.warn('Import paused: FFmpeg unavailable', { queued: this.queue.length })
              this.queue = []
              this.batch = { total: 0, completed: 0, failed: 0 }
              break
            }
            throw error
          }
          const id = this.queue.shift()
          if (id) void this.process(id, tools)
        }
      } while (this.pumpAgain)
    } finally {
      this.pumping = false
    }
    this.afterChange()
  }

  private async process(id: string, tools: MediaTools): Promise<void> {
    let record: AssetRecord
    try {
      record = this.repo.record(id)
    } catch {
      return // removed meanwhile
    }
    const controller = new AbortController()
    this.active.set(id, { controller, fileName: record.fileName })
    this.repo.markProcessing(id)
    this.emitAsset(id)
    this.emitQueue()

    let claimedHash: string | null = null
    try {
      claimedHash = await this.analyse(record, tools, controller.signal)
      this.batch.completed++
    } catch (error) {
      if (this.shuttingDown) return // stays 'processing'; resumed on next start
      if (this.cancelled.has(id)) {
        // Cancelled by the user: it no longer counts towards this batch. Removed in `finally`.
        this.batch.total = Math.max(0, this.batch.total - 1)
      } else if (error instanceof MovedContentError) {
        this.batch.completed++
        // The new entry must go first: it holds the path the existing entry moves to.
        await this.discard(id)
        try {
          const info = await stat(error.target.path)
          const moved = this.repo.relink(
            error.existing.id,
            { ...error.target, pathKey: pathKey(error.target.path), mtimeMs: info.mtimeMs },
            false
          )
          this.emit({ type: 'asset', asset: moved })
          this.logger.info('Content renamed or moved; entry relinked', { id: moved.id, file: moved.fileName })
        } catch (relinkError) {
          this.logger.warn('Could not relink moved content', { id: error.existing.id, error: relinkError })
        }
      } else if (error instanceof DuplicateContentError) {
        this.batch.completed++
        this.cancelled.add(id)
        this.emit({ type: 'duplicate', fileName: record.fileName, existingFileName: error.existing.fileName })
        this.logger.info('Skipped duplicate', { file: record.fileName, existing: error.existing.id })
      } else {
        this.batch.completed++
        this.batch.failed++
        const message = this.describeFailure(error, record.fileName)
        const missing = error instanceof SourceMissingError
        this.logger.warn('Import failed', { id, file: record.sourcePath, message, error })
        try {
          this.repo.markError(id, message, missing ? 'missing' : undefined)
          this.emitAsset(id)
        } catch {
          // Removed meanwhile.
        }
      }
    } finally {
      if (claimedHash && this.claimedHashes.get(claimedHash) === id) this.claimedHashes.delete(claimedHash)
      this.active.delete(id)
      if (this.cancelled.delete(id)) await this.discard(id)
      void this.pump()
    }
  }

  /** Returns the content hash it claimed, so the caller can release it. */
  private async analyse(record: AssetRecord, tools: MediaTools, signal: AbortSignal): Promise<string> {
    const { id, sourcePath: path, fileName } = record
    if (!(await isFile(path))) throw new SourceMissingError()

    const fingerprint = await quickFingerprint(path)
    this.repo.setFingerprint(id, fingerprint.hash, fingerprint.size)
    const existing = this.repo.findByContentHash(fingerprint.hash, id)
    const claimant = this.claimedHashes.get(fingerprint.hash)
    if (existing && existing.status === 'ready') {
      // The same content under a new name. If the old file is gone, it was renamed or moved:
      // keep the existing entry (with its project and history) and point it at the new path.
      if (!this.isBusy(existing.id) && !(await isFile(existing.sourcePath))) {
        throw new MovedContentError(existing, { path, size: fingerprint.size, contentHash: fingerprint.hash })
      }
      throw new DuplicateContentError(existing)
    }
    if (claimant && claimant !== id) throw new DuplicateContentError(this.repo.get(claimant))
    this.claimedHashes.set(fingerprint.hash, id)
    throwIfAborted(signal)

    const { raw, interpretation } = await runProbe(tools, path, fileName, signal)
    if (!interpretation.ok) throw new MediaReadError(interpretation.message)
    const metadata = interpretation.metadata
    if (metadata.kind !== 'video') throw new NotVideoError()

    await verifyDecodable(tools, path, fileName, metadata, signal)

    let thumbnailPath: string | null = null
    if (metadata.kind === 'video') {
      thumbnailPath = join(this.options.thumbnailsDirectory, `${id}.jpg`)
      await createThumbnail(tools, path, fileName, metadata, thumbnailPath, this.options.tempDirectory, signal)
    }
    throwIfAborted(signal)

    this.repo.markReady(id, metadata, JSON.stringify(raw), thumbnailPath)
    this.emitAsset(id)
    return fingerprint.hash
  }

  private describeFailure(error: unknown, fileName: string): string {
    if (error instanceof MediaReadError) return error.message
    if (error instanceof NotVideoError) return `“${fileName}” não tem imagem de vídeo. A Social Machine importa apenas vídeos.`
    if (error instanceof SourceMissingError) return `“${fileName}” foi movido ou apagado antes de ser importado.`
    if (error instanceof ProcessError) {
      if (error.code === 'TIMEOUT') {
        return `A análise de “${fileName}” demorou demais e foi interrompida. O arquivo pode estar danificado, ser muito grande ou estar num disco lento.`
      }
      if (error.code === 'SPAWN') return `Não foi possível iniciar o FFmpeg (${error.message}).`
      return `O FFmpeg falhou ao ler “${fileName}”.${error.stderrSummary ? ` (${error.stderrSummary})` : ''}`
    }
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'EACCES' || code === 'EPERM') return `Sem permissão para ler “${fileName}”.`
    if (code === 'EBUSY') return `“${fileName}” está bloqueado por outro programa.`
    return `A importação de “${fileName}” falhou: ${(error as Error)?.message ?? String(error)}`
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                          */
  /* ---------------------------------------------------------------- */

  private async discard(id: string): Promise<void> {
    try {
      const { thumbnailPath } = this.repo.delete(id)
      await this.deleteThumbnail(thumbnailPath)
    } catch {
      // Already gone.
    }
    this.pendingRelinks.delete(id)
    // A thumbnail may have been written before cancellation reached the database.
    await this.deleteThumbnail(join(this.options.thumbnailsDirectory, `${id}.jpg`))
    this.emit({ type: 'removed', id })
  }

  /** Deletes a thumbnail, but only inside the app's thumbnails folder. */
  private async deleteThumbnail(path: string | null): Promise<void> {
    if (!path) return
    const rel = relative(this.options.thumbnailsDirectory, path)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return
    await rm(path, { force: true }).catch(() => undefined)
  }

  private emit(event: MediaEvent): void {
    try {
      this.options.emit(event)
    } catch (error) {
      this.logger.warn('Media event delivery failed', { error })
    }
  }

  private emitAsset(id: string): void {
    const asset = this.repo.find(id)
    if (asset) this.emit({ type: 'asset', asset })
  }

  private emitQueue(): void {
    this.emit({ type: 'queue', state: this.queueState() })
  }

  private afterChange(): void {
    this.emitQueue()
    if (!this.queueState().active) {
      this.batch = { total: 0, completed: 0, failed: 0 }
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const resolve of waiters) resolve()
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ProcessError('ABORTED', 'Cancelled')
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!
      await fn(item)
    }
  })
  await Promise.all(workers)
}

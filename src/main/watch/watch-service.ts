import { watch as fsWatch } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ImportOptions, MediaStatus } from '../../shared/media'
import type { WatchFolderStatus, WatchState } from '../../shared/watch'
import type { Logger } from '../logger'
import { collectImportCandidates, hasMediaExtension, pathKey as defaultPathKey, VIDEO_EXTENSION_SET } from '../media/files'
import type { WatchFolderRecord, WatchFoldersRepository } from '../repositories/watch-folders'

export type KnownFile = { id: string; status: MediaStatus; size: number; mtimeMs: number | null }

/** Minimal handle returned by a file-system watcher. */
export type WatchHandle = { close(): void }

/**
 * Creates a watcher for a folder. `onChange` receives a path relative to the
 * folder, or null when the platform can't tell which file changed.
 */
export type WatchFactory = (
  directory: string,
  onChange: (relativePath: string | null) => void,
  onError: (error: Error) => void
) => WatchHandle

export type WatchServiceOptions = {
  folders: WatchFoldersRepository
  /** Files already in the library, keyed by path key. */
  knownFiles: () => Map<string, KnownFile>
  /** Imports stable files. Rejects without side effects when importing is impossible (e.g. FFmpeg missing). */
  importer: (paths: string[], options: ImportOptions) => Promise<unknown>
  logger: Logger
  /** Called whenever folder status changes. */
  emit: (folders: WatchFolderStatus[]) => void
  /** Full rescan interval. Read on every cycle so a settings change applies without restart. */
  scanIntervalMs: () => number
  /** How often files that are still being written are re-checked. */
  stabilityIntervalMs?: number
  /** Consecutive unchanged checks (size and mtime) before a file counts as complete. */
  stableChecksRequired?: number
  watchFactory?: WatchFactory
  pathKey?: (path: string) => string
}

type Candidate = {
  path: string
  size: number
  mtimeMs: number
  stableChecks: number
}

type FolderRuntime = {
  record: WatchFolderRecord
  handle: WatchHandle | null
  state: WatchState
  waiting: Map<string, Candidate>
  scanning: Promise<void> | null
  rescanTimer: NodeJS.Timeout | null
}

/** Names that are never imported: hidden, Office lock files, and common partial-download/temp suffixes. */
const IGNORED_SUFFIXES = ['.tmp', '.temp', '.part', '.partial', '.crdownload', '.download', '.!ut']

export function isIgnoredFileName(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower.startsWith('.') || lower.startsWith('~$')) return true
  return IGNORED_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

/** Recursive fs.watch. Supported on Windows and macOS, and on Linux since Node 20. */
export const nodeWatchFactory: WatchFactory = (directory, onChange, onError) => {
  const watcher = fsWatch(directory, { recursive: true, persistent: false }, (_event, filename) => {
    onChange(filename ? filename.toString() : null)
  })
  watcher.on('error', onError)
  return watcher
}

/**
 * Keeps watched folders in sync with the library (TD-104).
 *
 * Three mechanisms, so that a missed event never means a missed file:
 *  1. file-system events, for fast detection while the app runs;
 *  2. a periodic full rescan;
 *  3. a rescan of every folder on start (reconciliation), which picks up
 *     files created while the app was closed.
 *
 * A file is imported only after its size and modification time stayed the
 * same for several consecutive checks and it can be opened for reading, so
 * files still being rendered or copied are not imported half-written. Files
 * are only read; nothing in a watched folder is ever moved, renamed or deleted.
 */
export class WatchService {
  private readonly runtimes = new Map<string, FolderRuntime>()
  private readonly importing = new Set<string>()
  /**
   * Files already handed to the importer, with the size and mtime they had. A file the importer
   * dropped (e.g. a duplicate of a library item) is not in the library, so without this it would be
   * handed over again on every scan. It is reconsidered only if it changes.
   */
  private readonly handled = new Map<string, { size: number; mtimeMs: number }>()
  private readonly stabilityIntervalMs: number
  private readonly stableChecksRequired: number
  private readonly watchFactory: WatchFactory
  private readonly pathKey: (path: string) => string
  private scanTimer: NodeJS.Timeout | null = null
  private stabilityTimer: NodeJS.Timeout | null = null
  private checking = false
  private stopped = true

  constructor(private readonly options: WatchServiceOptions) {
    this.stabilityIntervalMs = options.stabilityIntervalMs ?? 2000
    this.stableChecksRequired = options.stableChecksRequired ?? 2
    this.watchFactory = options.watchFactory ?? nodeWatchFactory
    this.pathKey = options.pathKey ?? ((p) => defaultPathKey(p))
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  /** Attaches watchers and reconciles every folder with the library. */
  async start(): Promise<void> {
    this.stopped = false
    this.syncFolders()
    this.stabilityTimer = setInterval(() => void this.checkCandidates(), this.stabilityIntervalMs)
    this.stabilityTimer.unref?.()
    this.scheduleRescan()
    await this.scanAll()
  }

  stop(): void {
    this.stopped = true
    if (this.scanTimer) clearTimeout(this.scanTimer)
    if (this.stabilityTimer) clearInterval(this.stabilityTimer)
    this.scanTimer = null
    this.stabilityTimer = null
    for (const runtime of this.runtimes.values()) this.detach(runtime)
    this.runtimes.clear()
  }

  /** Re-reads folders from the database after they were added, changed or removed. */
  async refresh(): Promise<void> {
    const added = this.syncFolders()
    this.emitStatus()
    await Promise.all(added.map((id) => this.scanFolder(id)))
  }

  /** Rescans one folder or all of them now. */
  async scanNow(id?: string): Promise<void> {
    if (id) await this.scanFolder(id)
    else await this.scanAll()
  }

  status(): WatchFolderStatus[] {
    return [...this.runtimes.values()].map((runtime) => this.describe(runtime))
  }

  /** Resolves when no file is waiting or being handed to the importer (used by tests). */
  async waitForIdle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const busy =
        this.importing.size > 0 ||
        [...this.runtimes.values()].some((r) => r.waiting.size > 0 || r.scanning !== null)
      if (!busy) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('Watch service did not become idle in time')
  }

  /* ---------------------------------------------------------------- */
  /* Folders                                                          */
  /* ---------------------------------------------------------------- */

  /** Brings runtimes in line with the database. Returns ids of folders that need a scan. */
  private syncFolders(): string[] {
    const records = this.options.folders.list()
    const ids = new Set(records.map((r) => r.id))
    const needScan: string[] = []

    for (const [id, runtime] of this.runtimes) {
      if (!ids.has(id)) {
        this.detach(runtime)
        this.runtimes.delete(id)
      }
    }

    for (const record of records) {
      const runtime = this.runtimes.get(record.id)
      if (!runtime) {
        this.runtimes.set(record.id, {
          record,
          handle: null,
          state: record.enabled ? 'polling' : 'disabled',
          waiting: new Map(),
          scanning: null,
          rescanTimer: null
        })
        if (record.enabled) needScan.push(record.id)
        continue
      }
      const wasEnabled = runtime.record.enabled
      runtime.record = record
      if (!record.enabled) {
        this.detach(runtime)
        runtime.state = 'disabled'
      } else if (!wasEnabled) {
        runtime.state = 'polling'
        needScan.push(record.id)
      }
    }
    return needScan
  }

  private attach(runtime: FolderRuntime): void {
    if (runtime.handle || this.stopped) return
    const { record } = runtime
    try {
      runtime.handle = this.watchFactory(
        record.path,
        (relativePath) => this.onFsEvent(record.id, relativePath),
        (error) => {
          this.options.logger.warn('Folder watcher failed; falling back to periodic scans', {
            folder: record.path,
            error
          })
          this.detach(runtime)
          runtime.state = 'polling'
          this.emitStatus()
        }
      )
      runtime.state = 'watching'
    } catch (error) {
      runtime.handle = null
      runtime.state = 'polling'
      this.options.logger.warn('Could not watch folder; using periodic scans', { folder: record.path, error })
    }
  }

  private detach(runtime: FolderRuntime): void {
    if (runtime.rescanTimer) clearTimeout(runtime.rescanTimer)
    runtime.rescanTimer = null
    runtime.waiting.clear()
    if (!runtime.handle) return
    try {
      runtime.handle.close()
    } catch {
      // Already closed.
    }
    runtime.handle = null
  }

  /* ---------------------------------------------------------------- */
  /* Scanning                                                         */
  /* ---------------------------------------------------------------- */

  private scheduleRescan(): void {
    if (this.stopped) return
    this.scanTimer = setTimeout(() => {
      void this.scanAll().finally(() => this.scheduleRescan())
    }, this.options.scanIntervalMs())
    this.scanTimer.unref?.()
  }

  private async scanAll(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((id) => this.scanFolder(id)))
  }

  private scanFolder(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (!runtime || !runtime.record.enabled || this.stopped) return Promise.resolve()
    if (runtime.scanning) return runtime.scanning
    runtime.scanning = this.doScan(runtime).finally(() => {
      runtime.scanning = null
      this.emitStatus()
    })
    return runtime.scanning
  }

  private async doScan(runtime: FolderRuntime): Promise<void> {
    const { record } = runtime
    let error: string | null = null
    try {
      const info = await stat(record.path).catch(() => null)
      if (!info || !info.isDirectory()) {
        this.detach(runtime)
        runtime.state = 'unavailable'
        error = 'A pasta não foi encontrada. Ela será verificada de novo automaticamente.'
        return
      }
      this.attach(runtime)

      const scan = await collectImportCandidates([record.path], { extensions: VIDEO_EXTENSION_SET, maxFiles: 50_000 })
      if (scan.errors.length) error = scan.errors[0]!.message
      if (scan.truncated) this.options.logger.warn('Watched folder has too many files; scan truncated', { folder: record.path })

      const known = this.options.knownFiles()
      for (const file of scan.files) await this.consider(runtime, file, known)
    } catch (scanError) {
      error = `Falha ao verificar a pasta: ${(scanError as Error).message}`
      this.options.logger.warn('Watched folder scan failed', { folder: record.path, error: scanError })
    } finally {
      try {
        this.options.folders.recordScan(record.id, error)
        runtime.record = { ...runtime.record, lastScanAt: new Date().toISOString(), lastError: error }
      } catch {
        // Folder removed meanwhile.
      }
    }
  }

  private onFsEvent(folderId: string, relativePath: string | null): void {
    const runtime = this.runtimes.get(folderId)
    if (!runtime || this.stopped) return
    if (relativePath && hasMediaExtension(relativePath, VIDEO_EXTENSION_SET)) {
      const full = join(runtime.record.path, relativePath)
      void this.consider(runtime, full, this.options.knownFiles()).then(() => this.emitStatus())
      return
    }
    // Unknown file or a folder change (e.g. a subfolder copied in): rescan shortly, debounced.
    if (runtime.rescanTimer) clearTimeout(runtime.rescanTimer)
    runtime.rescanTimer = setTimeout(() => {
      runtime.rescanTimer = null
      void this.scanFolder(folderId)
    }, 1000)
    runtime.rescanTimer.unref?.()
  }

  /** Starts tracking a file if it is new, or changed since a failed import. */
  private async consider(runtime: FolderRuntime, path: string, known: Map<string, KnownFile>): Promise<void> {
    if (isIgnoredFileName(basename(path))) return
    const key = this.pathKey(path)
    if (runtime.waiting.has(key) || this.importing.has(key)) return

    let info
    try {
      info = await stat(path)
    } catch {
      return // deleted again, or a transient rename
    }
    if (!info.isFile()) return

    const existing = known.get(key)
    const previous = this.handled.get(key)
    if (!existing && previous && previous.size === info.size && previous.mtimeMs === info.mtimeMs) return
    if (existing) {
      const changed = existing.size !== info.size || existing.mtimeMs === null || Math.abs(existing.mtimeMs - info.mtimeMs) > 1
      // Ready, pending or processing files are already handled. A failed file is retried once it changes
      // (e.g. a render that was still being written when it was first seen).
      if (existing.status !== 'error' || !changed) return
    }

    runtime.waiting.set(key, { path, size: info.size, mtimeMs: info.mtimeMs, stableChecks: 0 })
  }

  /* ---------------------------------------------------------------- */
  /* Stability                                                        */
  /* ---------------------------------------------------------------- */

  private async checkCandidates(): Promise<void> {
    if (this.checking || this.stopped) return
    this.checking = true
    try {
      for (const runtime of this.runtimes.values()) {
        const ready: string[] = []
        for (const [key, candidate] of runtime.waiting) {
          let info
          try {
            info = await stat(candidate.path)
          } catch {
            runtime.waiting.delete(key) // gone
            continue
          }
          const unchanged = info.size === candidate.size && info.mtimeMs === candidate.mtimeMs
          if (!unchanged || info.size === 0) {
            candidate.size = info.size
            candidate.mtimeMs = info.mtimeMs
            candidate.stableChecks = 0
            continue
          }
          candidate.stableChecks++
          if (candidate.stableChecks < this.stableChecksRequired) continue
          if (!(await isReadable(candidate.path))) {
            candidate.stableChecks = 0 // locked by the program writing it
            continue
          }
          runtime.waiting.delete(key)
          this.handled.set(key, { size: info.size, mtimeMs: info.mtimeMs })
          ready.push(candidate.path)
        }
        if (ready.length) await this.hand(runtime, ready)
      }
    } finally {
      this.checking = false
    }
    this.emitStatus()
  }

  private async hand(runtime: FolderRuntime, paths: string[]): Promise<void> {
    const keys = paths.map((p) => this.pathKey(p))
    for (const key of keys) this.importing.add(key)
    const { record } = runtime
    try {
      await this.options.importer(paths, {
        projectId: record.projectId,
        origin: record.origin,
        watchFolderId: record.id
      })
      this.options.logger.info('Imported from watched folder', { folder: record.path, files: paths.length })
    } catch (error) {
      // Nothing was recorded; the next scan finds these files again.
      for (const key of keys) this.handled.delete(key)
      this.options.logger.warn('Import from watched folder deferred', { folder: record.path, error })
    } finally {
      for (const key of keys) this.importing.delete(key)
    }
  }

  /* ---------------------------------------------------------------- */
  /* Status                                                           */
  /* ---------------------------------------------------------------- */

  private describe(runtime: FolderRuntime): WatchFolderStatus {
    const r = runtime.record
    return {
      id: r.id,
      path: r.path,
      label: r.label,
      origin: r.origin,
      projectId: r.projectId,
      enabled: r.enabled,
      lastScanAt: r.lastScanAt,
      lastError: r.lastError,
      createdAt: r.createdAt,
      state: runtime.state,
      waitingFiles: runtime.waiting.size
    }
  }

  private emitStatus(): void {
    try {
      this.options.emit(this.status())
    } catch (error) {
      this.options.logger.warn('Watch status delivery failed', { error })
    }
  }
}

async function isReadable(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'r')
    await handle.close()
    return true
  } catch {
    return false
  }
}

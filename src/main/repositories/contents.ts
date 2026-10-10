import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { SqlDriver } from '../db/driver'
import { transaction } from '../db/driver'
import { NotFoundError } from '../errors'
import type {
  ContentItem,
  ContentOrigin,
  ImportOptions,
  LibraryStats,
  MediaAvailability,
  MediaKind,
  MediaStatus,
  WorkflowStatus
} from '../../shared/media'
import { WORKFLOW_STATUSES } from '../../shared/media'
import type { MediaMetadata } from '../media/probe'

type Row = {
  id: string
  project_id: string | null
  title: string | null
  origin: ContentOrigin
  watch_folder_id: string | null
  workflow_status: WorkflowStatus
  source_path: string
  path_key: string
  file_name: string
  file_size: number
  file_mtime_ms: number | null
  content_hash: string | null
  kind: MediaKind | null
  status: MediaStatus
  error_message: string | null
  availability: MediaAvailability
  duration_seconds: number | null
  container: string | null
  video_codec: string | null
  audio_codec: string | null
  width: number | null
  height: number | null
  frame_rate: number | null
  rotation: number | null
  sample_rate: number | null
  channels: number | null
  bit_rate: number | null
  thumbnail_path: string | null
  imported_at: string
  updated_at: string
}

const n = (v: number | bigint | null): number | null => (v === null ? null : Number(v))

function toAsset(row: Row): ContentItem {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    origin: row.origin,
    watchFolderId: row.watch_folder_id,
    workflowStatus: row.workflow_status,
    fileName: row.file_name,
    sourcePath: row.source_path,
    fileSize: Number(row.file_size),
    kind: row.kind,
    status: row.status,
    errorMessage: row.error_message,
    availability: row.availability,
    durationSeconds: n(row.duration_seconds),
    container: row.container,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    width: n(row.width),
    height: n(row.height),
    frameRate: n(row.frame_rate),
    rotation: n(row.rotation),
    sampleRate: n(row.sample_rate),
    channels: n(row.channels),
    bitRate: n(row.bit_rate),
    hasThumbnail: row.thumbnail_path !== null,
    importedAt: row.imported_at,
    updatedAt: row.updated_at
  }
}

const COLUMNS = `id, project_id, title, origin, watch_folder_id, workflow_status, source_path, path_key, file_name, file_size, file_mtime_ms, content_hash, kind, status,
  error_message, availability, duration_seconds, container, video_codec, audio_codec, width, height,
  frame_rate, rotation, sample_rate, channels, bit_rate, thumbnail_path, imported_at, updated_at`

const CLEAR_METADATA = `kind = NULL, duration_seconds = NULL, container = NULL, video_codec = NULL,
  audio_codec = NULL, width = NULL, height = NULL, frame_rate = NULL, rotation = NULL, sample_rate = NULL,
  channels = NULL, bit_rate = NULL, probe_json = NULL`

/** Internal fields the import service needs but the renderer never sees. */
export type AssetRecord = ContentItem & {
  pathKey: string
  contentHash: string | null
  thumbnailPath: string | null
  fileMtimeMs: number | null
}

/**
 * Persistence for media assets. Only references and derived data are stored:
 * source files are never copied, moved or deleted.
 */
export class ContentsRepository {
  constructor(
    private readonly db: SqlDriver,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = randomUUID
  ) {}

  private row(id: string): Row | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM contents WHERE id = ?`).get(id) as Row | undefined
  }

  list(): ContentItem[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM contents ORDER BY imported_at DESC, file_name`).all() as Row[]).map(
      toAsset
    )
  }

  get(id: string): ContentItem {
    const row = this.row(id)
    if (!row) throw new NotFoundError('Esse conteúdo não está mais na biblioteca.')
    return toAsset(row)
  }

  find(id: string): ContentItem | null {
    const row = this.row(id)
    return row ? toAsset(row) : null
  }

  record(id: string): AssetRecord {
    const row = this.row(id)
    if (!row) throw new NotFoundError('Esse conteúdo não está mais na biblioteca.')
    return {
      ...toAsset(row),
      pathKey: row.path_key,
      contentHash: row.content_hash,
      thumbnailPath: row.thumbnail_path,
      fileMtimeMs: n(row.file_mtime_ms)
    }
  }

  findByPathKey(key: string): ContentItem | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM contents WHERE path_key = ?`).get(key) as Row | undefined
    return row ? toAsset(row) : null
  }

  /** Another asset with the same content (used to skip duplicates and to verify relinks). */
  findByContentHash(hash: string, excludeId: string): ContentItem | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM contents WHERE content_hash = ? AND id <> ? AND status <> 'error' LIMIT 1`)
      .get(hash, excludeId) as Row | undefined
    return row ? toAsset(row) : null
  }

  /** Inserts a pending content. Returns null if a file with that path is already in the library. */
  insertPending(input: { path: string; pathKey: string; size: number; mtimeMs: number } & ImportOptions): ContentItem | null {
    const id = this.newId()
    const t = this.now()
    const origin = input.origin ?? 'manual'
    const workflow = input.workflowStatus ?? (origin === 'manual' ? 'imported' : 'needs_review')
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO contents
           (id, project_id, origin, watch_folder_id, workflow_status, source_path, path_key, file_name, file_size,
            file_mtime_ms, status, availability, imported_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'online', ?, ?)`
      )
      .run(
        id,
        input.projectId ?? null,
        origin,
        input.watchFolderId ?? null,
        workflow,
        input.path,
        input.pathKey,
        basename(input.path),
        input.size,
        input.mtimeMs,
        t,
        t
      )
    return Number(result.changes) === 1 ? this.get(id) : null
  }

  /** Path key, status, size and mtime of every content (used by folder watching to skip known files). */
  knownFiles(): Map<string, { id: string; status: MediaStatus; size: number; mtimeMs: number | null }> {
    const rows = this.db.prepare('SELECT id, path_key, status, file_size, file_mtime_ms FROM contents').all() as {
      id: string
      path_key: string
      status: MediaStatus
      file_size: number
      file_mtime_ms: number | null
    }[]
    return new Map(
      rows.map((r) => [r.path_key, { id: r.id, status: r.status, size: Number(r.file_size), mtimeMs: n(r.file_mtime_ms) }])
    )
  }

  /** Updates recorded size/mtime, e.g. when a failed file changed on disk and is retried. */
  updateFileStats(id: string, size: number, mtimeMs: number): void {
    this.db
      .prepare('UPDATE contents SET file_size = ?, file_mtime_ms = ?, updated_at = ? WHERE id = ?')
      .run(size, mtimeMs, this.now(), id)
  }

  setWorkflowStatus(ids: readonly string[], status: WorkflowStatus): ContentItem[] {
    return transaction(this.db, () => {
      const stmt = this.db.prepare('UPDATE contents SET workflow_status = ?, updated_at = ? WHERE id = ?')
      for (const id of ids) stmt.run(status, this.now(), id)
      return ids.map((id) => this.find(id)).filter((c): c is ContentItem => c !== null)
    })
  }

  setProject(ids: readonly string[], projectId: string | null): ContentItem[] {
    return transaction(this.db, () => {
      const stmt = this.db.prepare('UPDATE contents SET project_id = ?, updated_at = ? WHERE id = ?')
      for (const id of ids) stmt.run(projectId, this.now(), id)
      return ids.map((id) => this.find(id)).filter((c): c is ContentItem => c !== null)
    })
  }

  setTitle(id: string, title: string | null): ContentItem {
    this.get(id)
    this.db.prepare('UPDATE contents SET title = ?, updated_at = ? WHERE id = ?').run(title, this.now(), id)
    return this.get(id)
  }

  stats(): LibraryStats {
    const byWorkflow = Object.fromEntries(WORKFLOW_STATUSES.map((s) => [s, 0])) as Record<WorkflowStatus, number>
    const rows = this.db
      .prepare('SELECT workflow_status AS s, COUNT(*) AS c FROM contents GROUP BY workflow_status')
      .all() as { s: WorkflowStatus; c: number }[]
    let total = 0
    for (const row of rows) {
      byWorkflow[row.s] = Number(row.c)
      total += Number(row.c)
    }
    const count = (where: string) =>
      Number((this.db.prepare(`SELECT COUNT(*) AS c FROM contents WHERE ${where}`).get() as { c: number }).c)
    return {
      total,
      byWorkflow,
      withoutProject: count('project_id IS NULL'),
      errors: count(`status = 'error'`),
      missing: count(`availability = 'missing'`)
    }
  }

  pendingIds(): string[] {
    return (
      this.db.prepare(`SELECT id FROM contents WHERE status = 'pending' ORDER BY imported_at, file_name`).all() as {
        id: string
      }[]
    ).map((r) => r.id)
  }

  /** After a crash or forced quit, work that was in progress is queued again. */
  resetInterrupted(): number {
    const result = this.db
      .prepare(`UPDATE contents SET status = 'pending', updated_at = ? WHERE status = 'processing'`)
      .run(this.now())
    return Number(result.changes)
  }

  markProcessing(id: string): void {
    this.db
      .prepare(`UPDATE contents SET status = 'processing', error_message = NULL, updated_at = ? WHERE id = ?`)
      .run(this.now(), id)
  }

  setFingerprint(id: string, hash: string, size: number): void {
    this.db
      .prepare(`UPDATE contents SET content_hash = ?, file_size = ?, updated_at = ? WHERE id = ?`)
      .run(hash, size, this.now(), id)
  }

  markReady(id: string, metadata: MediaMetadata, probeJson: string, thumbnailPath: string | null): ContentItem {
    this.db
      .prepare(
        `UPDATE contents SET
           status = 'ready', error_message = NULL, availability = 'online',
           kind = ?, duration_seconds = ?, container = ?, video_codec = ?, audio_codec = ?,
           width = ?, height = ?, frame_rate = ?, rotation = ?, sample_rate = ?, channels = ?,
           bit_rate = ?, probe_json = ?, thumbnail_path = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        metadata.kind,
        metadata.durationSeconds,
        metadata.container,
        metadata.video?.codec ?? null,
        metadata.audio?.codec ?? null,
        metadata.video?.width ?? null,
        metadata.video?.height ?? null,
        metadata.video?.frameRate ?? null,
        metadata.video?.rotation ?? null,
        metadata.audio?.sampleRate ?? null,
        metadata.audio?.channels ?? null,
        metadata.bitRate === null ? null : Math.round(metadata.bitRate),
        probeJson,
        thumbnailPath,
        this.now(),
        id
      )
    return this.get(id)
  }

  markError(id: string, message: string, availability?: MediaAvailability): ContentItem {
    this.db
      .prepare(
        `UPDATE contents SET status = 'error', error_message = ?, availability = COALESCE(?, availability),
           updated_at = ? WHERE id = ?`
      )
      .run(message, availability ?? null, this.now(), id)
    return this.get(id)
  }

  requeue(id: string): ContentItem {
    this.db
      .prepare(`UPDATE contents SET status = 'pending', error_message = NULL, updated_at = ? WHERE id = ?`)
      .run(this.now(), id)
    return this.get(id)
  }

  setAvailability(id: string, availability: MediaAvailability): ContentItem {
    this.db
      .prepare(`UPDATE contents SET availability = ?, availability_checked_at = ?, updated_at = ? WHERE id = ?`)
      .run(availability, this.now(), this.now(), id)
    return this.get(id)
  }

  /**
   * Points an asset at a new file location. With `resetMetadata` the asset is
   * re-imported (the file's content differs from what was analysed before).
   */
  relink(
    id: string,
    input: { path: string; pathKey: string; size: number; mtimeMs: number; contentHash: string },
    resetMetadata: boolean
  ): ContentItem {
    this.db
      .prepare(
        `UPDATE contents SET source_path = ?, path_key = ?, file_name = ?, file_size = ?, file_mtime_ms = ?,
           content_hash = ?, availability = 'online', availability_checked_at = ?, updated_at = ?
           ${resetMetadata ? `, status = 'pending', error_message = NULL, thumbnail_path = NULL, ${CLEAR_METADATA}` : ''}
         WHERE id = ?`
      )
      .run(input.path, input.pathKey, basename(input.path), input.size, input.mtimeMs, input.contentHash, this.now(), this.now(), id)
    return this.get(id)
  }

  /** Removes the library entry only. Returns the thumbnail path so the caller can delete that file. */
  delete(id: string): { thumbnailPath: string | null } {
    const row = this.row(id)
    if (!row) throw new NotFoundError('Esse conteúdo não está mais na biblioteca.')
    this.db.prepare('DELETE FROM contents WHERE id = ?').run(id)
    return { thumbnailPath: row.thumbnail_path }
  }

  missingAssets(): AssetRecord[] {
    const ids = (this.db.prepare(`SELECT id FROM contents WHERE availability = 'missing'`).all() as { id: string }[]).map(
      (r) => r.id
    )
    return ids.map((id) => this.record(id))
  }

  allLocations(): { id: string; sourcePath: string; availability: MediaAvailability }[] {
    return (
      this.db.prepare('SELECT id, source_path, availability FROM contents').all() as {
        id: string
        source_path: string
        availability: MediaAvailability
      }[]
    ).map((r) => ({ id: r.id, sourcePath: r.source_path, availability: r.availability }))
  }
}

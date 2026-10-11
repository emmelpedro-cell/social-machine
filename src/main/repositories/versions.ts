import { randomUUID } from 'node:crypto'
import type { SqlDriver } from '../db/driver'
import { NotFoundError } from '../errors'
import {
  defaultEditSettings,
  EditSettingsSchema,
  type ContentVersion,
  type EditSettings,
  type VersionStatus
} from '../../shared/editor'

type Row = {
  id: string
  content_id: string
  version_name: string
  file_path: string | null
  edit_settings_json: string
  duration_seconds: number | null
  width: number | null
  height: number | null
  aspect_ratio: string | null
  status: VersionStatus
  error_message: string | null
  progress: number
  encoder: string | null
  file_size: number | null
  thumbnail_path: string | null
  created_at: string
  updated_at: string
}

const COLUMNS = `id, content_id, version_name, file_path, edit_settings_json, duration_seconds, width, height,
  aspect_ratio, status, error_message, progress, encoder, file_size, thumbnail_path, created_at, updated_at`

const n = (v: number | bigint | null): number | null => (v === null ? null : Number(v))

function parseSettings(json: string): EditSettings {
  try {
    const parsed = EditSettingsSchema.safeParse(JSON.parse(json))
    if (parsed.success) return parsed.data
  } catch {
    // Fall through: an unreadable row still lists, with default settings.
  }
  return defaultEditSettings()
}

function toVersion(row: Row): ContentVersion {
  return {
    id: row.id,
    contentId: row.content_id,
    name: row.version_name,
    status: row.status,
    progress: Number(row.progress),
    errorMessage: row.error_message,
    settings: parseSettings(row.edit_settings_json),
    filePath: row.file_path,
    fileSize: n(row.file_size),
    durationSeconds: n(row.duration_seconds),
    width: n(row.width),
    height: n(row.height),
    aspectRatio: row.aspect_ratio,
    encoder: row.encoder,
    hasThumbnail: row.thumbnail_path !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export type VersionRecord = ContentVersion & { thumbnailPath: string | null }

/** Edited renditions of a content. The original file is never referenced for writing. */
export class VersionsRepository {
  constructor(
    private readonly db: SqlDriver,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = randomUUID
  ) {}

  private row(id: string): Row | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM content_versions WHERE id = ?`).get(id) as Row | undefined
  }

  get(id: string): ContentVersion {
    const row = this.row(id)
    if (!row) throw new NotFoundError('Essa versão não existe mais.')
    return toVersion(row)
  }

  find(id: string): ContentVersion | null {
    const row = this.row(id)
    return row ? toVersion(row) : null
  }

  record(id: string): VersionRecord {
    const row = this.row(id)
    if (!row) throw new NotFoundError('Essa versão não existe mais.')
    return { ...toVersion(row), thumbnailPath: row.thumbnail_path }
  }

  listForContent(contentId: string): ContentVersion[] {
    return (
      this.db
        .prepare(`SELECT ${COLUMNS} FROM content_versions WHERE content_id = ? ORDER BY created_at DESC`)
        .all(contentId) as Row[]
    ).map(toVersion)
  }

  /** Number of versions per content, for library cards. */
  countsByContent(): Map<string, number> {
    const rows = this.db
      .prepare(`SELECT content_id, COUNT(*) AS c FROM content_versions GROUP BY content_id`)
      .all() as { content_id: string; c: number }[]
    return new Map(rows.map((r) => [r.content_id, Number(r.c)]))
  }

  /** Names already used for a content's versions (case-insensitive). */
  namesFor(contentId: string): Set<string> {
    const rows = this.db.prepare('SELECT version_name FROM content_versions WHERE content_id = ?').all(contentId) as {
      version_name: string
    }[]
    return new Set(rows.map((r) => r.version_name.toLowerCase()))
  }

  createRendering(input: { contentId: string; name: string; settings: EditSettings; filePath: string }): ContentVersion {
    const id = this.newId()
    const t = this.now()
    this.db
      .prepare(
        `INSERT INTO content_versions
           (id, content_id, version_name, file_path, edit_settings_json, status, progress, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'rendering', 0, ?, ?)`
      )
      .run(id, input.contentId, input.name, input.filePath, JSON.stringify(input.settings), t, t)
    return this.get(id)
  }

  /** Ids of versions that were rendering when the app stopped. */
  renderingIds(): string[] {
    return (
      this.db.prepare(`SELECT id FROM content_versions WHERE status = 'rendering' ORDER BY created_at`).all() as { id: string }[]
    ).map((r) => r.id)
  }

  setProgress(id: string, progress: number): void {
    this.db
      .prepare('UPDATE content_versions SET progress = ?, updated_at = ? WHERE id = ?')
      .run(Math.max(0, Math.min(1, progress)), this.now(), id)
  }

  setRendering(id: string): ContentVersion {
    this.db
      .prepare(`UPDATE content_versions SET status = 'rendering', progress = 0, error_message = NULL, updated_at = ? WHERE id = ?`)
      .run(this.now(), id)
    return this.get(id)
  }

  markReady(
    id: string,
    output: {
      fileSize: number
      durationSeconds: number
      width: number
      height: number
      aspectRatio: string
      encoder: string
      thumbnailPath: string | null
    }
  ): ContentVersion {
    this.db
      .prepare(
        `UPDATE content_versions SET status = 'ready', progress = 1, error_message = NULL, file_size = ?,
           duration_seconds = ?, width = ?, height = ?, aspect_ratio = ?, encoder = ?, thumbnail_path = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        output.fileSize,
        output.durationSeconds,
        output.width,
        output.height,
        output.aspectRatio,
        output.encoder,
        output.thumbnailPath,
        this.now(),
        id
      )
    return this.get(id)
  }

  markError(id: string, message: string): ContentVersion {
    this.db
      .prepare(`UPDATE content_versions SET status = 'error', error_message = ?, updated_at = ? WHERE id = ?`)
      .run(message, this.now(), id)
    return this.get(id)
  }

  rename(id: string, name: string): ContentVersion {
    this.get(id)
    this.db.prepare('UPDATE content_versions SET version_name = ?, updated_at = ? WHERE id = ?').run(name, this.now(), id)
    return this.get(id)
  }

  delete(id: string): void {
    const result = this.db.prepare('DELETE FROM content_versions WHERE id = ?').run(id)
    if (Number(result.changes) === 0) throw new NotFoundError('Essa versão não existe mais.')
  }

  /** True when a publication references the version (Phase 3); such versions can't be deleted. */
  isPublished(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM publications WHERE content_version_id = ? LIMIT 1').get(id) !== undefined
  }
}

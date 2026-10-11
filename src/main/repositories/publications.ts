import { randomUUID } from 'node:crypto'
import type { SqlDriver } from '../db/driver'
import { transaction } from '../db/driver'
import { NotFoundError } from '../errors'
import type {
  PlatformId,
  Publication,
  PublicationFields,
  PublicationStatus,
  PublicationSummary
} from '../../shared/publishing'

type Row = {
  id: string
  content_id: string
  content_version_id: string | null
  account_id: string
  title: string | null
  caption: string | null
  hashtags_json: string
  fields_json: string
  scheduled_at: string | null
  published_at: string | null
  external_post_id: string | null
  external_url: string | null
  status: PublicationStatus
  error_message: string | null
  idempotency_key: string
  created_at: string
  updated_at: string
}

type SummaryRow = Row & {
  account_name: string
  platform_id: PlatformId
  content_title: string | null
  content_file_name: string
  version_name: string | null
}

const COLUMNS = `p.id, p.content_id, p.content_version_id, p.account_id, p.title, p.caption, p.hashtags_json, p.fields_json,
  p.scheduled_at, p.published_at, p.external_post_id, p.external_url, p.status, p.error_message, p.idempotency_key,
  p.created_at, p.updated_at`

function json<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function toPublication(row: Row): Publication {
  return {
    id: row.id,
    contentId: row.content_id,
    versionId: row.content_version_id,
    accountId: row.account_id,
    title: row.title,
    caption: row.caption,
    hashtags: json<string[]>(row.hashtags_json, []),
    fields: json<PublicationFields>(row.fields_json, {}),
    status: row.status,
    errorMessage: row.error_message,
    externalPostId: row.external_post_id,
    externalUrl: row.external_url,
    scheduledAt: row.scheduled_at,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** One row per destination. A failure in one destination never touches the others. */
export class PublicationsRepository {
  constructor(
    private readonly db: SqlDriver,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = randomUUID
  ) {}

  private row(id: string): Row | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM publications p WHERE p.id = ?`).get(id) as Row | undefined
  }

  get(id: string): Publication {
    const row = this.row(id)
    if (!row) throw new NotFoundError('Essa publicação não existe mais.')
    return toPublication(row)
  }

  find(id: string): Publication | null {
    const row = this.row(id)
    return row ? toPublication(row) : null
  }

  findByKey(key: string): Publication | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM publications p WHERE p.idempotency_key = ?`).get(key) as Row | undefined
    return row ? toPublication(row) : null
  }

  /** Publications of a version to an account that are done or on their way (to warn about repeats). */
  activeFor(versionId: string, accountId: string): Publication[] {
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM publications p
           WHERE p.content_version_id = ? AND p.account_id = ?
             AND p.status IN ('queued', 'scheduled', 'publishing', 'published', 'manual_pending', 'draft')`
        )
        .all(versionId, accountId) as Row[]
    ).map(toPublication)
  }

  create(input: {
    contentId: string
    versionId: string
    accountId: string
    title: string | null
    caption: string | null
    hashtags: string[]
    fields: PublicationFields
    status: PublicationStatus
    idempotencyKey: string
    scheduledAt?: string | null
  }): Publication {
    const id = this.newId()
    const t = this.now()
    this.db
      .prepare(
        `INSERT INTO publications (id, content_id, content_version_id, account_id, title, caption, hashtags_json, fields_json,
           status, idempotency_key, scheduled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.contentId,
        input.versionId,
        input.accountId,
        input.title,
        input.caption,
        JSON.stringify(input.hashtags),
        JSON.stringify(input.fields),
        input.status,
        input.idempotencyKey,
        input.scheduledAt ?? null,
        t,
        t
      )
    return this.get(id)
  }

  list(filter: { contentId?: string; limit?: number } = {}): PublicationSummary[] {
    const where = filter.contentId ? 'WHERE p.content_id = ?' : ''
    const params = filter.contentId ? [filter.contentId] : []
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS}, a.display_name AS account_name, a.platform_id AS platform_id,
           c.title AS content_title, c.file_name AS content_file_name, v.version_name AS version_name
         FROM publications p
         JOIN accounts a ON a.id = p.account_id
         JOIN contents c ON c.id = p.content_id
         LEFT JOIN content_versions v ON v.id = p.content_version_id
         ${where}
         ORDER BY p.created_at DESC
         LIMIT ?`
      )
      .all(...params, filter.limit ?? 200) as SummaryRow[]
    return rows.map((r) => ({
      ...toPublication(r),
      accountName: r.account_name,
      platformId: r.platform_id,
      contentName: r.content_title ?? r.content_file_name,
      versionName: r.version_name
    }))
  }

  /**
   * Publications planned or active in a time range (by scheduled time, or by creation time when unscheduled),
   * plus everything waiting for the user (manual pending, missed, failed, paused) regardless of date.
   */
  listQueue(range: { from: string; to: string }): (PublicationSummary & { projectId: string | null })[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS}, a.display_name AS account_name, a.platform_id AS platform_id,
           c.title AS content_title, c.file_name AS content_file_name, c.project_id AS project_id, v.version_name AS version_name
         FROM publications p
         JOIN accounts a ON a.id = p.account_id
         JOIN contents c ON c.id = p.content_id
         LEFT JOIN content_versions v ON v.id = p.content_version_id
         WHERE (p.status IN ('scheduled', 'queued', 'publishing', 'published') AND COALESCE(p.scheduled_at, p.published_at, p.created_at) BETWEEN ? AND ?)
            OR p.status IN ('manual_pending', 'failed', 'draft')
            OR (p.status = 'scheduled' AND json_extract(p.fields_json, '$.missed') = 1)
         ORDER BY COALESCE(p.scheduled_at, p.published_at, p.created_at)`
      )
      .all(range.from, range.to) as (SummaryRow & { project_id: string | null })[]
    return rows.map((r) => ({
      ...toPublication(r),
      accountName: r.account_name,
      platformId: r.platform_id,
      contentName: r.content_title ?? r.content_file_name,
      versionName: r.version_name,
      projectId: r.project_id
    }))
  }

  /** Planned times of an account's publications (for free-slot search). */
  plannedTimes(accountId: string, from: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT scheduled_at FROM publications WHERE account_id = ? AND scheduled_at IS NOT NULL AND scheduled_at >= ?
             AND status IN ('scheduled', 'queued', 'publishing', 'draft', 'published')`
        )
        .all(accountId, from) as { scheduled_at: string }[]
    ).map((r) => r.scheduled_at)
  }

  /** Scheduled publications whose time has come. */
  due(now: string): Publication[] {
    return (
      this.db
        .prepare(`SELECT ${COLUMNS} FROM publications p WHERE p.status = 'scheduled' AND p.scheduled_at IS NOT NULL AND p.scheduled_at <= ? ORDER BY p.scheduled_at`)
        .all(now) as Row[]
    ).map(toPublication)
  }

  setSchedule(id: string, scheduledAt: string | null): Publication {
    this.db.prepare('UPDATE publications SET scheduled_at = ?, updated_at = ? WHERE id = ?').run(scheduledAt, this.now(), id)
    return this.get(id)
  }

  /**
   * Moves a publication from one status to another only if it is still in the expected one.
   * Returns false when someone else got there first (prevents double publishing).
   */
  transition(id: string, from: PublicationStatus, to: PublicationStatus): boolean {
    const result = this.db
      .prepare('UPDATE publications SET status = ?, error_message = NULL, updated_at = ? WHERE id = ? AND status = ?')
      .run(to, this.now(), id, from)
    return Number(result.changes) === 1
  }

  /** The platform accepted the upload and will publish at the scheduled time (YouTube publishAt). */
  markUploadedScheduled(id: string, result: { externalPostId: string | null; externalUrl: string | null }): Publication {
    return transaction(this.db, () => {
      const current = this.get(id)
      const { upload: _u, progress: _p, ...fields } = current.fields
      this.db
        .prepare(
          `UPDATE publications SET status = 'scheduled', error_message = NULL, external_post_id = ?, external_url = ?,
             fields_json = ?, updated_at = ? WHERE id = ?`
        )
        .run(result.externalPostId, result.externalUrl, JSON.stringify(fields), this.now(), id)
      return this.get(id)
    })
  }

  /** A platform-scheduled publication reached its time: it is live on the platform. */
  markLiveAt(id: string, at: string): Publication {
    this.db
      .prepare(`UPDATE publications SET status = 'published', published_at = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'`)
      .run(at, this.now(), id)
    return this.get(id)
  }

  idsWithStatus(statuses: PublicationStatus[]): string[] {
    const marks = statuses.map(() => '?').join(', ')
    return (
      this.db.prepare(`SELECT id FROM publications WHERE status IN (${marks}) ORDER BY created_at`).all(...statuses) as { id: string }[]
    ).map((r) => r.id)
  }

  setStatus(id: string, status: PublicationStatus, error: string | null = null): Publication {
    this.db
      .prepare('UPDATE publications SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
      .run(status, error, this.now(), id)
    return this.get(id)
  }

  /** Merges platform fields (e.g. upload session, progress). */
  updateFields(id: string, patch: Partial<PublicationFields>): Publication {
    return transaction(this.db, () => {
      const current = this.get(id)
      const fields = { ...current.fields, ...patch }
      for (const key of Object.keys(patch) as (keyof PublicationFields)[]) {
        if (patch[key] === undefined) delete fields[key]
      }
      this.db.prepare('UPDATE publications SET fields_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(fields), this.now(), id)
      return this.get(id)
    })
  }

  markPublished(id: string, result: { externalPostId: string | null; externalUrl: string | null }): Publication {
    return transaction(this.db, () => {
      const current = this.get(id)
      const { upload: _u, progress: _p, ...fields } = current.fields
      this.db
        .prepare(
          `UPDATE publications SET status = 'published', error_message = NULL, external_post_id = ?, external_url = ?,
             published_at = ?, fields_json = ?, updated_at = ? WHERE id = ?`
        )
        .run(result.externalPostId, result.externalUrl, this.now(), JSON.stringify(fields), this.now(), id)
      return this.get(id)
    })
  }
}

import { randomUUID } from 'node:crypto'
import type { SqlDriver } from '../db/driver'
import { NotFoundError, ConflictError } from '../errors'
import type {
  AccountAnalytics,
  AccountSnapshot,
  MetricSnapshot,
  MetricSource,
  MetricValues,
  PerformanceRow
} from '../../shared/analytics'
import type { PlatformId } from '../../shared/publishing'

type SnapshotRow = {
  id: string
  publication_id: string
  captured_at: string
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  watch_time_seconds: number | null
  average_view_duration_seconds: number | null
  followers_gained: number | null
  additional_json: string
  source: MetricSource
}

const SNAPSHOT_COLUMNS = `s.id, s.publication_id, s.captured_at, s.views, s.likes, s.comments, s.shares, s.watch_time_seconds,
  s.average_view_duration_seconds, s.followers_gained, s.additional_json, s.source`

function num(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v)
}

function toSnapshot(row: SnapshotRow): MetricSnapshot {
  let extra: MetricValues['extra'] = {}
  try {
    extra = JSON.parse(row.additional_json) as MetricValues['extra']
  } catch {
    extra = {}
  }
  return {
    id: row.id,
    publicationId: row.publication_id,
    capturedAt: row.captured_at,
    source: row.source,
    views: num(row.views),
    likes: num(row.likes),
    comments: num(row.comments),
    shares: num(row.shares),
    followersGained: num(row.followers_gained),
    watchTimeSeconds: num(row.watch_time_seconds),
    averageViewDurationSeconds: num(row.average_view_duration_seconds),
    extra
  }
}

type PerfRow = {
  publication_id: string
  content_id: string
  content_title: string | null
  content_file_name: string
  version_name: string | null
  project_id: string | null
  account_id: string
  account_name: string
  platform_id: PlatformId
  is_manual: number
  title: string | null
  external_url: string | null
  published_at: string
  aspect_ratio: string | null
  version_duration: number | null
  content_duration: number | null
} & { [K in keyof SnapshotRow as `m_${K}`]: SnapshotRow[K] | null }

/** Metric snapshots (history, never overwritten) and the joins Analytics needs. */
export class MetricsRepository {
  constructor(
    private readonly db: SqlDriver,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = randomUUID
  ) {}

  insert(publicationId: string, capturedAt: string, values: MetricValues, source: MetricSource): MetricSnapshot {
    const id = this.newId()
    this.db
      .prepare(
        `INSERT INTO metric_snapshots (id, publication_id, captured_at, views, likes, comments, shares, watch_time_seconds,
           average_view_duration_seconds, followers_gained, additional_json, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        publicationId,
        capturedAt,
        values.views,
        values.likes,
        values.comments,
        values.shares,
        values.watchTimeSeconds,
        values.averageViewDurationSeconds,
        values.followersGained,
        JSON.stringify(values.extra ?? {}),
        source
      )
    return this.get(id)
  }

  get(id: string): MetricSnapshot {
    const row = this.db.prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM metric_snapshots s WHERE s.id = ?`).get(id) as SnapshotRow | undefined
    if (!row) throw new NotFoundError('Esse registro de métricas não existe mais.')
    return toSnapshot(row)
  }

  /** Only numbers typed in by the user can be deleted; API history is kept. */
  deleteManual(id: string): MetricSnapshot {
    const snapshot = this.get(id)
    if (snapshot.source !== 'manual') throw new ConflictError('Só é possível apagar números informados por você.')
    this.db.prepare('DELETE FROM metric_snapshots WHERE id = ?').run(id)
    return snapshot
  }

  history(publicationIds: readonly string[]): Record<string, MetricSnapshot[]> {
    const out: Record<string, MetricSnapshot[]> = Object.fromEntries(publicationIds.map((id) => [id, []]))
    if (publicationIds.length === 0) return out
    const marks = publicationIds.map(() => '?').join(', ')
    const rows = this.db
      .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM metric_snapshots s WHERE s.publication_id IN (${marks}) ORDER BY s.captured_at, s.rowid`)
      .all(...publicationIds) as SnapshotRow[]
    for (const row of rows) out[row.publication_id]!.push(toSnapshot(row))
    return out
  }

  /** When the API last captured this publication (manual entries don't count). */
  lastApiCapture(publicationId: string): string | null {
    const row = this.db
      .prepare(`SELECT MAX(captured_at) AS at FROM metric_snapshots WHERE publication_id = ? AND source = 'api'`)
      .get(publicationId) as { at: string | null } | undefined
    return row?.at ?? null
  }

  /** Published publications whose metrics come from an API (have a post id on a non-manual account). */
  collectable(accountId?: string): { id: string; accountId: string; externalPostId: string; publishedAt: string; lastCapture: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.account_id, p.external_post_id, p.published_at,
           (SELECT MAX(captured_at) FROM metric_snapshots s WHERE s.publication_id = p.id AND s.source = 'api') AS last_capture
         FROM publications p JOIN accounts a ON a.id = p.account_id
         WHERE p.status = 'published' AND p.external_post_id IS NOT NULL AND p.published_at IS NOT NULL
           AND a.is_manual = 0 AND a.connection_status = 'connected' ${accountId ? 'AND a.id = ?' : ''}
         ORDER BY p.published_at DESC`
      )
      .all(...(accountId ? [accountId] : [])) as {
      id: string
      account_id: string
      external_post_id: string
      published_at: string
      last_capture: string | null
    }[]
    return rows.map((r) => ({ id: r.id, accountId: r.account_id, externalPostId: r.external_post_id, publishedAt: r.published_at, lastCapture: r.last_capture }))
  }

  insertAccount(accountId: string, capturedAt: string, values: { followers: number | null; totalViews: number | null; videoCount: number | null }): AccountSnapshot {
    const id = this.newId()
    this.db
      .prepare(
        'INSERT INTO account_metric_snapshots (id, account_id, captured_at, followers, total_views, video_count) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(id, accountId, capturedAt, values.followers, values.totalViews, values.videoCount)
    return { id, accountId, capturedAt, ...values }
  }

  accountHistory(accountId: string): AccountSnapshot[] {
    return (
      this.db
        .prepare('SELECT id, account_id, captured_at, followers, total_views, video_count FROM account_metric_snapshots WHERE account_id = ? ORDER BY captured_at')
        .all(accountId) as { id: string; account_id: string; captured_at: string; followers: number | null; total_views: number | null; video_count: number | null }[]
    ).map((r) => ({
      id: r.id,
      accountId: r.account_id,
      capturedAt: r.captured_at,
      followers: num(r.followers),
      totalViews: num(r.total_views),
      videoCount: num(r.video_count)
    }))
  }

  setCollectionStatus(accountId: string, error: string | null): void {
    this.db.prepare('UPDATE accounts SET metrics_checked_at = ?, metrics_error = ? WHERE id = ?').run(this.now(), error, accountId)
  }

  accounts(automatic: (platformId: PlatformId, manual: boolean) => boolean): AccountAnalytics[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.display_name, a.platform_id, a.is_manual, a.metrics_checked_at, a.metrics_error,
           (SELECT followers FROM account_metric_snapshots s WHERE s.account_id = a.id AND s.followers IS NOT NULL ORDER BY captured_at DESC LIMIT 1) AS followers,
           (SELECT followers FROM account_metric_snapshots s WHERE s.account_id = a.id AND s.followers IS NOT NULL ORDER BY captured_at ASC LIMIT 1) AS first_followers,
           (SELECT captured_at FROM account_metric_snapshots s WHERE s.account_id = a.id AND s.followers IS NOT NULL ORDER BY captured_at ASC LIMIT 1) AS first_at
         FROM accounts a ORDER BY a.platform_id, a.display_name COLLATE NOCASE`
      )
      .all() as {
      id: string
      display_name: string
      platform_id: PlatformId
      is_manual: number
      metrics_checked_at: string | null
      metrics_error: string | null
      followers: number | null
      first_followers: number | null
      first_at: string | null
    }[]
    return rows.map((r) => {
      const manual = Number(r.is_manual) === 1
      return {
        accountId: r.id,
        accountName: r.display_name,
        platformId: r.platform_id,
        manual,
        automatic: automatic(r.platform_id, manual),
        checkedAt: r.metrics_checked_at,
        error: r.metrics_error,
        followers: num(r.followers),
        followersFirst: r.first_followers !== null && r.first_at ? { value: Number(r.first_followers), at: r.first_at } : null
      }
    })
  }

  /** Published publications with their latest snapshot (API or manual, whichever is newer). */
  performance(filter: { contentId?: string } = {}): PerformanceRow[] {
    const m = (c: string) => `(SELECT ${c} FROM metric_snapshots s WHERE s.publication_id = p.id ORDER BY s.captured_at DESC, s.rowid DESC LIMIT 1)`
    const snapshotCols = [
      'id',
      'publication_id',
      'captured_at',
      'views',
      'likes',
      'comments',
      'shares',
      'watch_time_seconds',
      'average_view_duration_seconds',
      'followers_gained',
      'additional_json',
      'source'
    ]
      .map((c) => `${m(c)} AS m_${c}`)
      .join(',\n')
    const rows = this.db
      .prepare(
        `SELECT p.id AS publication_id, p.content_id, c.title AS content_title, c.file_name AS content_file_name,
           v.version_name, c.project_id, p.account_id, a.display_name AS account_name, a.platform_id, a.is_manual,
           p.title, p.external_url, p.published_at, v.aspect_ratio, v.duration_seconds AS version_duration,
           c.duration_seconds AS content_duration,
           ${snapshotCols}
         FROM publications p
         JOIN accounts a ON a.id = p.account_id
         JOIN contents c ON c.id = p.content_id
         LEFT JOIN content_versions v ON v.id = p.content_version_id
         WHERE p.status = 'published' AND p.published_at IS NOT NULL ${filter.contentId ? 'AND p.content_id = ?' : ''}
         ORDER BY p.published_at DESC`
      )
      .all(...(filter.contentId ? [filter.contentId] : [])) as PerfRow[]
    return rows.map((r) => ({
      publicationId: r.publication_id,
      contentId: r.content_id,
      contentName: r.content_title ?? r.content_file_name,
      versionName: r.version_name,
      projectId: r.project_id,
      accountId: r.account_id,
      accountName: r.account_name,
      platformId: r.platform_id,
      manual: Number(r.is_manual) === 1,
      title: r.title,
      externalUrl: r.external_url,
      publishedAt: r.published_at,
      aspectRatio: r.aspect_ratio,
      durationSeconds: num(r.version_duration ?? r.content_duration),
      latest: r.m_id
        ? toSnapshot({
            id: r.m_id,
            publication_id: r.m_publication_id!,
            captured_at: r.m_captured_at!,
            views: r.m_views,
            likes: r.m_likes,
            comments: r.m_comments,
            shares: r.m_shares,
            watch_time_seconds: r.m_watch_time_seconds,
            average_view_duration_seconds: r.m_average_view_duration_seconds,
            followers_gained: r.m_followers_gained,
            additional_json: r.m_additional_json ?? '{}',
            source: r.m_source ?? 'api'
          })
        : null
    }))
  }
}

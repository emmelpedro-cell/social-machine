import { z } from 'zod'
import type { PlatformId } from './publishing'

/**
 * Analytics (Phase 5). Every number comes from a platform API or was typed
 * in by the user from the platform's own app; a value that isn't available
 * is `null` and shown as "indisponível" — never as zero, never estimated.
 */

export const METRIC_KEYS = [
  'views',
  'likes',
  'comments',
  'shares',
  'followersGained',
  'watchTimeSeconds',
  'averageViewDurationSeconds'
] as const
export type MetricKey = (typeof METRIC_KEYS)[number]

/** Metrics that add up across publications (averages don't). */
export const SUMMABLE_KEYS = ['views', 'likes', 'comments', 'shares', 'followersGained', 'watchTimeSeconds'] as const
export type SummableKey = (typeof SUMMABLE_KEYS)[number]

export const METRIC_LABELS: Record<MetricKey, string> = {
  views: 'Visualizações',
  likes: 'Curtidas',
  comments: 'Comentários',
  shares: 'Compartilhamentos',
  followersGained: 'Seguidores/inscritos ganhos',
  watchTimeSeconds: 'Tempo assistido',
  averageViewDurationSeconds: 'Duração média assistida'
}

export type MetricValues = {
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  followersGained: number | null
  watchTimeSeconds: number | null
  averageViewDurationSeconds: number | null
  /** Platform-specific extras, e.g. YouTube's averageViewPercentage (a retention summary). */
  extra: { averageViewPercentage?: number | null; analyticsIncluded?: boolean }
}

export const emptyMetrics = (): MetricValues => ({
  views: null,
  likes: null,
  comments: null,
  shares: null,
  followersGained: null,
  watchTimeSeconds: null,
  averageViewDurationSeconds: null,
  extra: {}
})

export type MetricSource = 'api' | 'manual'

export type MetricSnapshot = MetricValues & {
  id: string
  publicationId: string
  capturedAt: string
  source: MetricSource
}

export type AccountSnapshot = {
  id: string
  accountId: string
  capturedAt: string
  followers: number | null
  totalViews: number | null
  videoCount: number | null
}

/** A published publication with what's needed to compare it. */
export type PerformanceRow = {
  publicationId: string
  contentId: string
  contentName: string
  versionName: string | null
  projectId: string | null
  accountId: string
  accountName: string
  platformId: PlatformId
  manual: boolean
  title: string | null
  externalUrl: string | null
  publishedAt: string
  /** Output aspect of the published version (e.g. "9:16"), when known. */
  aspectRatio: string | null
  durationSeconds: number | null
  /** Whether the published version has on-screen text (null when unknown, e.g. no version). */
  hasText: boolean | null
  /**
   * Views at the 24 h and 7 d marks: the last reading taken shortly before the mark
   * (within 6 h for 24 h, within 2 days for 7 d). Null until the mark is reached or
   * when no reading is close enough — so posts of different ages compare fairly.
   */
  views24h: number | null
  views7d: number | null
  latest: MetricSnapshot | null
}

export type AccountAnalytics = {
  accountId: string
  accountName: string
  platformId: PlatformId
  manual: boolean
  /** Whether the app collects this account's metrics through an API. */
  automatic: boolean
  checkedAt: string | null
  error: string | null
  /** Latest followers/subscribers and the change since the first snapshot in the history. */
  followers: number | null
  followersFirst: { value: number; at: string } | null
}

export type AnalyticsOverview = { rows: PerformanceRow[]; accounts: AccountAnalytics[] }

export type ContentAnalytics = {
  rows: PerformanceRow[]
  /** Snapshot history per publication, oldest first. */
  history: Record<string, MetricSnapshot[]>
}

/* ------------------------------------------------------------------ */
/* Engagement                                                         */
/* ------------------------------------------------------------------ */

export const ENGAGEMENT_FORMULA = '(curtidas + comentários + compartilhamentos) ÷ visualizações'

/** Engagement rate (0..1) or null unless views, likes, comments and shares are all known and views > 0. */
export function engagementRate(m: Pick<MetricValues, 'views' | 'likes' | 'comments' | 'shares'> | null): number | null {
  if (!m || m.views === null || m.likes === null || m.comments === null || m.shares === null || m.views <= 0) return null
  return (m.likes + m.comments + m.shares) / m.views
}

/* ------------------------------------------------------------------ */
/* Aggregation (pure: used by the renderer for any grouping/filter)   */
/* ------------------------------------------------------------------ */

export type MetricTotal = { sum: number | null; withData: number }

export type Aggregate = {
  publications: number
  totals: Record<SummableKey, MetricTotal>
  /** Weighted: total interactions ÷ total views over publications with all four values. */
  engagement: { rate: number | null; withData: number }
  /** Views per publication among publications with a views value. */
  averageViews: number | null
}

/**
 * Sums only known values and counts how many publications had each one, so
 * a missing value lowers the coverage instead of pretending to be zero.
 */
export function aggregate(rows: readonly PerformanceRow[]): Aggregate {
  const totals = Object.fromEntries(SUMMABLE_KEYS.map((k) => [k, { sum: null, withData: 0 }])) as Record<SummableKey, MetricTotal>
  let interactions = 0
  let engagementViews = 0
  let engagementCount = 0
  for (const row of rows) {
    const m = row.latest
    if (!m) continue
    for (const key of SUMMABLE_KEYS) {
      const value = m[key]
      if (value === null || value === undefined) continue
      totals[key].sum = (totals[key].sum ?? 0) + value
      totals[key].withData++
    }
    if (engagementRate(m) !== null) {
      interactions += m.likes! + m.comments! + m.shares!
      engagementViews += m.views!
      engagementCount++
    }
  }
  return {
    publications: rows.length,
    totals,
    engagement: { rate: engagementViews > 0 ? interactions / engagementViews : null, withData: engagementCount },
    averageViews: totals.views.withData ? totals.views.sum! / totals.views.withData : null
  }
}

export function groupRows<K extends string>(rows: readonly PerformanceRow[], key: (row: PerformanceRow) => K): Map<K, PerformanceRow[]> {
  const map = new Map<K, PerformanceRow[]>()
  for (const row of rows) {
    const k = key(row)
    map.set(k, [...(map.get(k) ?? []), row])
  }
  return map
}

export const DURATION_BUCKETS: { key: string; label: string; max: number }[] = [
  { key: 'd15', label: 'até 15 s', max: 15 },
  { key: 'd30', label: '15–30 s', max: 30 },
  { key: 'd60', label: '30–60 s', max: 60 },
  { key: 'd180', label: '1–3 min', max: 180 },
  { key: 'dlong', label: 'mais de 3 min', max: Infinity }
]

export function durationBucket(seconds: number | null): string {
  if (seconds === null) return 'unknown'
  return DURATION_BUCKETS.find((b) => seconds <= b.max)!.key
}

export type AnalyticsPeriod = '7d' | '30d' | '90d' | 'all'
export const PERIOD_DAYS: Record<AnalyticsPeriod, number | null> = { '7d': 7, '30d': 30, '90d': 90, all: null }

/** Publications published within the period (by publication date). */
export function inPeriod(row: PerformanceRow, period: AnalyticsPeriod, now = Date.now()): boolean {
  const days = PERIOD_DAYS[period]
  return days === null || new Date(row.publishedAt).getTime() >= now - days * 86_400_000
}

/** Value of a snapshot at (or just before) `hoursAfter` hours since publication, for 24 h / 7 d / 30 d reports. */
export function valueAt(history: readonly MetricSnapshot[], publishedAt: string, hoursAfter: number, key: MetricKey): number | null {
  const limit = new Date(publishedAt).getTime() + hoursAfter * 3_600_000
  let found: number | null = null
  for (const s of history) {
    if (new Date(s.capturedAt).getTime() > limit) break
    if (s[key] !== null) found = s[key]
  }
  return found
}

/* ------------------------------------------------------------------ */
/* IPC inputs                                                         */
/* ------------------------------------------------------------------ */

const count = z.number().int().min(0).max(1e12).nullable()
const seconds = z.number().min(0).max(1e12).nullable()

export const ManualMetricsInputSchema = z
  .object({
    publicationId: z.string().uuid('Publicação inválida'),
    /** When the numbers were read in the platform's app. */
    capturedAt: z.string().datetime({ offset: true }),
    views: count,
    likes: count,
    comments: count,
    shares: count,
    followersGained: count,
    watchTimeSeconds: seconds,
    averageViewDurationSeconds: seconds
  })
  .strict()
export type ManualMetricsInput = z.input<typeof ManualMetricsInputSchema>

export const ContentAnalyticsInputSchema = z.object({ contentId: z.string().uuid('Conteúdo inválido') }).strict()
export const SnapshotIdInputSchema = z.object({ id: z.string().uuid('Registro inválido') }).strict()
export const RefreshMetricsInputSchema = z.object({ accountId: z.string().uuid('Conta inválida').optional() }).strict()

export type RefreshResult = { accounts: number; publications: number; errors: string[] }

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { runMigrations } from '../../src/main/db/migrations'
import type { SqlDriver } from '../../src/main/db/driver'
import { MetricsService, snapshotInterval } from '../../src/main/analytics/metrics-service'
import { YouTubeClientConfig } from '../../src/main/connectors/config'
import { ManualConnector } from '../../src/main/connectors/manual'
import { YouTubeConnector } from '../../src/main/connectors/youtube/connector'
import { AccountsRepository } from '../../src/main/repositories/accounts'
import { ContentsRepository } from '../../src/main/repositories/contents'
import { MetricsRepository } from '../../src/main/repositories/metrics'
import { PublicationsRepository } from '../../src/main/repositories/publications'
import { VersionsRepository } from '../../src/main/repositories/versions'
import { MemorySecretStore } from '../../src/main/secrets/token-store'
import { defaultEditSettings } from '../../src/shared/editor'
import {
  aggregate,
  durationBucket,
  emptyMetrics,
  engagementRate,
  inPeriod,
  valueAt,
  type MetricSnapshot,
  type PerformanceRow
} from '../../src/shared/analytics'
import { FakeGoogle } from '../helpers/fake-google'
import { createNodeSqliteDriver, memoryLogger } from '../helpers/node-sqlite-driver'

const HOUR = 3_600_000
const DAY = 24 * HOUR

describe('analytics', () => {
  let google: FakeGoogle
  let db: SqlDriver
  let accounts: AccountsRepository
  let publications: PublicationsRepository
  let metrics: MetricsRepository
  let youtube: YouTubeConnector
  let service: MetricsService
  let clock: number
  let events: number
  let contentId: string
  let versionId: string

  beforeEach(async () => {
    google = new FakeGoogle()
    await google.start()
    db = createNodeSqliteDriver()
    runMigrations(db)
    const secrets = new MemorySecretStore()
    accounts = new AccountsRepository(db)
    publications = new PublicationsRepository(db)
    metrics = new MetricsRepository(db)
    const config = new YouTubeClientConfig(db, secrets)
    config.set({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'x' })
    clock = Date.parse('2026-10-11T12:00:00Z')
    events = 0
    youtube = new YouTubeConnector({
      accounts,
      secrets,
      config,
      fetch: (url, init) => fetch(url, init),
      openBrowser: google.approve,
      logger: memoryLogger(),
      endpoints: google.endpoints,
      now: () => clock
    })
    service = new MetricsService({
      metrics,
      accounts,
      publications,
      connectors: { youtube, tiktok: new ManualConnector('tiktok'), instagram: new ManualConnector('instagram') },
      logger: memoryLogger(),
      emit: () => events++,
      now: () => clock,
      tickMs: 0
    })
    const contents = new ContentsRepository(db)
    contentId = contents.insertPending({ path: '/src/ko.mp4', pathKey: '/src/ko.mp4', size: 1, mtimeMs: 1 })!.id
    const versions = new VersionsRepository(db)
    const v = versions.createRendering({ contentId, name: 'Clean 9:16', settings: defaultEditSettings(), filePath: '/out/ko.mp4' })
    versions.markReady(v.id, { fileSize: 1, durationSeconds: 24, width: 1080, height: 1920, aspectRatio: '9:16', encoder: 'libopenh264', thumbnailPath: null })
    versionId = v.id
  })

  afterEach(async () => {
    service.shutdown()
    await google.stop()
    db.close()
  })

  /** A publication already published on `accountId`, `ageMs` ago. */
  function published(accountId: string, externalPostId: string | null, ageMs: number) {
    const p = publications.create({
      contentId,
      versionId,
      accountId,
      title: 'Nocaute',
      caption: null,
      hashtags: [],
      fields: {},
      status: 'publishing',
      idempotencyKey: randomUUID()
    })
    publications.markPublished(p.id, { externalPostId, externalUrl: externalPostId ? `https://www.youtube.com/shorts/${externalPostId}` : null })
    const at = new Date(clock - ageMs).toISOString()
    db.prepare('UPDATE publications SET published_at = ? WHERE id = ?').run(at, p.id)
    return publications.get(p.id)
  }

  it('collects counters from the Data API and watch time, shares and subscribers from YouTube Analytics', async () => {
    const account = await youtube.connect([])
    const a = published(account.id, 'vidA', 3 * DAY)
    const b = published(account.id, 'vidB', 5 * HOUR)
    google.videoStats.set('vidA', { viewCount: '1500', likeCount: '120', commentCount: '14' })
    google.videoStats.set('vidB', { viewCount: '80', commentCount: '2' }) // likes hidden by the owner
    google.videoAnalytics.set('vidA', { minutes: 300, avgDuration: 12, avgPercentage: 55.5, shares: 9, subscribers: 4 })
    // vidB is too new for Analytics: no row.

    const result = await service.refresh()
    expect(result).toEqual({ accounts: 1, publications: 2, errors: [] })
    expect(events).toBe(1)

    const query = google.analyticsQueries[0]!
    expect(query.get('ids')).toBe('channel==MINE')
    expect(query.get('dimensions')).toBe('video')
    expect(query.get('filters')).toBe('video==vidB,vidA')
    expect(query.get('startDate')).toBe('2026-10-08')
    expect(query.get('endDate')).toBe('2026-10-11')

    const history = metrics.history([a.id, b.id])
    expect(history[a.id]).toEqual([
      expect.objectContaining({
        source: 'api',
        views: 1500,
        likes: 120,
        comments: 14,
        shares: 9,
        followersGained: 4,
        watchTimeSeconds: 18000,
        averageViewDurationSeconds: 12,
        extra: { averageViewPercentage: 55.5, analyticsIncluded: true }
      })
    ])
    // Missing values stay null — never zero.
    expect(history[b.id]![0]).toMatchObject({ views: 80, likes: null, comments: 2, shares: null, watchTimeSeconds: null, followersGained: null })

    const overview = service.overview()
    expect(overview.accounts.find((x) => x.accountId === account.id)).toMatchObject({ automatic: true, followers: 1200, error: null })
    expect(overview.rows.find((r) => r.publicationId === a.id)).toMatchObject({ aspectRatio: '9:16', durationSeconds: 24, platformId: 'youtube' })
  })

  it('keeps the counters and explains it when the YouTube Analytics API is not enabled', async () => {
    const account = await youtube.connect([])
    const a = published(account.id, 'vidA', 2 * DAY)
    google.videoStats.set('vidA', { viewCount: '10', likeCount: '1', commentCount: '0' })
    google.analyticsDisabled = true
    const result = await service.refresh(account.id)
    expect(result.errors[0]).toMatch(/Analytics API não está ativada/)
    expect(metrics.history([a.id])[a.id]![0]).toMatchObject({ views: 10, likes: 1, comments: 0, shares: null, extra: { analyticsIncluded: false } })
    expect(service.overview().accounts[0]!.error).toMatch(/Analytics API não está ativada/)

    // Once enabled, the next collection clears the message.
    google.analyticsDisabled = false
    google.videoAnalytics.set('vidA', { minutes: 1, avgDuration: 6, avgPercentage: 40, shares: 0, subscribers: 0 })
    await service.refresh(account.id)
    expect(service.overview().accounts[0]!.error).toBeNull()
    expect(metrics.history([a.id])[a.id]).toHaveLength(2)
    expect(metrics.history([a.id])[a.id]![1]).toMatchObject({ shares: 0, followersGained: 0 })
  })

  it('notes videos YouTube no longer returns, without inventing numbers for them', async () => {
    const account = await youtube.connect([])
    const gone = published(account.id, 'deleted-video', 2 * DAY)
    const result = await service.refresh()
    expect(result.publications).toBe(0)
    expect(metrics.history([gone.id])[gone.id]).toEqual([])
    expect(service.overview().accounts[0]!.error).toMatch(/não foram encontrados/)
  })

  it('takes snapshots more often while a post is new', async () => {
    expect(snapshotInterval(HOUR)).toBe(3 * HOUR)
    expect(snapshotInterval(10 * DAY)).toBe(12 * HOUR)
    expect(snapshotInterval(100 * DAY)).toBe(72 * HOUR)
    expect(snapshotInterval(400 * DAY)).toBe(14 * DAY)

    const account = await youtube.connect([])
    const fresh = published(account.id, 'vidA', HOUR)
    const old = published(account.id, 'vidB', 10 * DAY)
    google.videoStats.set('vidA', { viewCount: '1' })
    google.videoStats.set('vidB', { viewCount: '2' })

    expect((await service.collectDue()).publications).toBe(2)
    clock += 4 * HOUR
    expect((await service.collectDue()).publications).toBe(1) // only the new one
    expect(metrics.history([fresh.id])[fresh.id]).toHaveLength(2)
    expect(metrics.history([old.id])[old.id]).toHaveLength(1)
    clock += 9 * HOUR
    expect((await service.collectDue()).publications).toBe(2)
    // Disconnected accounts are skipped.
    accounts.setStatus(account.id, 'expired', 'x')
    clock += 30 * DAY
    expect((await service.collectDue()).accounts).toBe(0)
  })

  it('asks to reconnect when the login was revoked', async () => {
    const account = await youtube.connect([])
    published(account.id, 'vidA', DAY)
    google.invalidateAccessTokens()
    google.refreshFails = true
    const result = await service.refresh()
    expect(result.errors[0]).toMatch(/Conecte|conecte|expir|revog/i)
    expect(accounts.get(account.id).connectionStatus).toBe('expired')
  })

  it('reads the 24 h and 7 d marks from readings close to them, only once reached', async () => {
    const account = await youtube.connect([])
    const old = published(account.id, 'vidA', 10 * DAY)
    const stale = published(account.id, 'vidB', 10 * DAY)
    const fresh = published(account.id, 'vidC', 3 * DAY)
    const at = (p: { publishedAt: string | null }, hours: number) => new Date(new Date(p.publishedAt!).getTime() + hours * HOUR).toISOString()
    const values = (views: number) => ({ ...emptyMetrics(), views })
    metrics.insert(old.id, at(old, 20), values(100), 'api')
    metrics.insert(old.id, at(old, 6.5 * 24), values(900), 'api')
    metrics.insert(old.id, at(old, 9 * 24), values(1500), 'api')
    metrics.insert(stale.id, at(stale, 2 * 24), values(400), 'api') // nothing near the 7-day mark
    metrics.insert(fresh.id, at(fresh, 23), values(50), 'api')
    const rows = new Map(service.overview().rows.map((r) => [r.publicationId, r]))
    expect(rows.get(old.id)).toMatchObject({ views24h: 100, views7d: 900, hasText: false })
    expect(rows.get(stale.id)).toMatchObject({ views24h: null, views7d: null })
    expect(rows.get(fresh.id)).toMatchObject({ views24h: 50, views7d: null })
  })

  it('records numbers typed in for manual destinations, and only there', async () => {
    const yt = await youtube.connect([])
    const tiktok = accounts.addManual({ platformId: 'tiktok', displayName: '@cortes', projectIds: [] })
    const tt = published(tiktok.id, null, 2 * DAY)
    const ytPub = published(yt.id, 'vidA', 2 * DAY)
    const base = { views: 5000, likes: 400, comments: 30, shares: 25, followersGained: 12, watchTimeSeconds: null, averageViewDurationSeconds: null }

    const saved = service.addManual({ publicationId: tt.id, capturedAt: new Date(clock - HOUR).toISOString(), ...base })
    expect(saved).toMatchObject({ source: 'manual', views: 5000, shares: 25, watchTimeSeconds: null })
    expect(() => service.addManual({ publicationId: ytPub.id, capturedAt: new Date(clock).toISOString(), ...base })).toThrow(/vêm da API/)
    expect(() => service.addManual({ publicationId: tt.id, capturedAt: new Date(clock + DAY).toISOString(), ...base })).toThrow(/futuro/)
    expect(() => service.addManual({ publicationId: tt.id, capturedAt: new Date(clock - 3 * DAY).toISOString(), ...base })).toThrow(/anterior/)
    expect(() =>
      service.addManual({ publicationId: tt.id, capturedAt: new Date(clock).toISOString(), views: null, likes: null, comments: null, shares: null, followersGained: null, watchTimeSeconds: null, averageViewDurationSeconds: null })
    ).toThrow(/pelo menos um/)

    const row = service.overview().rows.find((r) => r.publicationId === tt.id)!
    expect(row).toMatchObject({ manual: true, latest: { source: 'manual', views: 5000 } })
    expect(service.overview().accounts.find((a) => a.accountId === tiktok.id)).toMatchObject({ automatic: false })
    await expect(service.refresh(tiktok.id)).rejects.toThrow(/não tem métricas automáticas/)

    // Content page: every destination with its history.
    const content = service.content(contentId)
    expect(content.rows.map((r) => r.publicationId).sort()).toEqual([tt.id, ytPub.id].sort())
    expect(content.history[tt.id]).toHaveLength(1)

    service.deleteManual(saved.id)
    expect(metrics.history([tt.id])[tt.id]).toEqual([])
    google.videoStats.set('vidA', { viewCount: '1' })
    await service.refresh()
    const apiSnapshot = metrics.history([ytPub.id])[ytPub.id]![0]!
    expect(() => service.deleteManual(apiSnapshot.id)).toThrow(/informados por você/)
  })
})

describe('aggregation', () => {
  const snap = (values: Partial<MetricSnapshot>): MetricSnapshot => ({
    ...emptyMetrics(),
    id: randomUUID(),
    publicationId: 'p',
    capturedAt: '2026-10-10T00:00:00Z',
    source: 'api',
    ...values
  })
  const row = (latest: MetricSnapshot | null, patch: Partial<PerformanceRow> = {}): PerformanceRow => ({
    publicationId: randomUUID(),
    contentId: 'c',
    contentName: 'x',
    versionName: null,
    projectId: null,
    accountId: 'a',
    accountName: 'A',
    platformId: 'youtube',
    manual: false,
    title: null,
    externalUrl: null,
    publishedAt: '2026-10-01T00:00:00Z',
    aspectRatio: '9:16',
    durationSeconds: 20,
    hasText: null,
    views24h: null,
    views7d: null,
    latest,
    ...patch
  })

  it('sums known values only and reports coverage; missing never counts as zero', () => {
    const result = aggregate([
      row(snap({ views: 1000, likes: 100, comments: 10, shares: 10 })),
      row(snap({ views: 500, likes: null, comments: 5, shares: null })),
      row(null)
    ])
    expect(result.publications).toBe(3)
    expect(result.totals.views).toEqual({ sum: 1500, withData: 2 })
    expect(result.totals.likes).toEqual({ sum: 100, withData: 1 })
    expect(result.totals.watchTimeSeconds).toEqual({ sum: null, withData: 0 })
    // Engagement only from the publication with all four values: 120 / 1000.
    expect(result.engagement).toEqual({ rate: 0.12, withData: 1 })
    expect(result.averageViews).toBe(750)
    expect(aggregate([]).engagement.rate).toBeNull()
  })

  it('defines engagement strictly', () => {
    expect(engagementRate({ views: 200, likes: 10, comments: 5, shares: 5 })).toBe(0.1)
    expect(engagementRate({ views: 0, likes: 0, comments: 0, shares: 0 })).toBeNull()
    expect(engagementRate({ views: 200, likes: 10, comments: 5, shares: null })).toBeNull()
  })

  it('reads values at report marks (24 h, 7 d) from the history', () => {
    const history = [
      snap({ capturedAt: '2026-10-01T03:00:00Z', views: 100 }),
      snap({ capturedAt: '2026-10-01T23:00:00Z', views: 900 }),
      snap({ capturedAt: '2026-10-05T00:00:00Z', views: 4000 })
    ]
    expect(valueAt(history, '2026-10-01T00:00:00Z', 24, 'views')).toBe(900)
    expect(valueAt(history, '2026-10-01T00:00:00Z', 7 * 24, 'views')).toBe(4000)
    expect(valueAt(history, '2026-10-01T00:00:00Z', 1, 'views')).toBeNull()
  })

  it('buckets durations and filters by period', () => {
    expect(durationBucket(12)).toBe('d15')
    expect(durationBucket(45)).toBe('d60')
    expect(durationBucket(600)).toBe('dlong')
    expect(durationBucket(null)).toBe('unknown')
    const now = Date.parse('2026-10-11T00:00:00Z')
    expect(inPeriod(row(null, { publishedAt: '2026-10-08T00:00:00Z' }), '7d', now)).toBe(true)
    expect(inPeriod(row(null, { publishedAt: '2026-09-01T00:00:00Z' }), '7d', now)).toBe(false)
    expect(inPeriod(row(null, { publishedAt: '2020-01-01T00:00:00Z' }), 'all', now)).toBe(true)
  })
})

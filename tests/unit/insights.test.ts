import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { emptyMetrics, type PerformanceRow } from '../../src/shared/analytics'
import { buildInsights, comparePeriods, median } from '../../src/shared/insights'
import type { PlatformId } from '../../src/shared/publishing'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-11T12:00:00Z')

function row(p: Partial<PerformanceRow> & { views7d: number | null }): PerformanceRow {
  return {
    publicationId: randomUUID(),
    contentId: randomUUID(),
    contentName: 'Clip',
    versionName: null,
    projectId: 'mma',
    accountId: 'a',
    accountName: 'A',
    platformId: 'youtube',
    manual: false,
    title: null,
    externalUrl: null,
    publishedAt: new Date(NOW - 20 * DAY).toISOString(),
    aspectRatio: '9:16',
    durationSeconds: 20,
    hasText: true,
    views24h: null,
    latest: { ...emptyMetrics(), id: randomUUID(), publicationId: 'p', capturedAt: new Date(NOW).toISOString(), source: 'api', views: p.views7d },
    ...p
  }
}

const names = (id: string | null) => (id === 'mma' ? 'MMA' : id === 'futebol' ? 'Futebol' : 'sem projeto')
// Fixed hours so the test doesn't depend on the machine's time zone.
const opts = { projectName: names, hourOf: () => 19, weekdayOf: () => 1 }

describe('insights', () => {
  it('says nothing conclusive with little data, and suggests tests instead', () => {
    const rows = [row({ views7d: 9000, durationSeconds: 20 }), row({ views7d: 1000, durationSeconds: 45 })]
    const report = buildInsights(rows, opts)
    expect(report.insights).toEqual([])
    expect(report.experiments.some((e) => /Teste duração em MMA no YouTube/.test(e.title))).toBe(true)
    expect(report.usable).toBe(2)
  })

  it('finds a duration trend within one project and platform, with counts and medians', () => {
    const short = Array.from({ length: 8 }, (_, i) => row({ views7d: 10_000 + i * 500, durationSeconds: 25 }))
    const long = Array.from({ length: 8 }, (_, i) => row({ views7d: 4_000 + i * 300, durationSeconds: 50 }))
    const viral = row({ views7d: 2_000_000, durationSeconds: 50 }) // one outlier doesn't flip a median
    const report = buildInsights([...short, ...long, viral], opts)
    const insight = report.insights.find((i) => i.dimension === 'duration')!
    expect(insight).toMatchObject({ evidence: 'trend', projectId: 'mma', platformId: 'youtube', sample: 17 })
    expect(insight.title).toBe('Em MMA no YouTube, vídeos de 15–30 s tiveram mais visualizações em 7 dias')
    expect(insight.groups.map((g) => [g.key, g.n])).toEqual([
      ['d30', 8],
      ['d60', 9]
    ])
    expect(insight.detail).toMatch(/não prova de causa/)
  })

  it('calls a smaller difference a hint and proposes confirming it; ignores small gaps', () => {
    const withText = Array.from({ length: 4 }, () => row({ views7d: 8000, hasText: true }))
    const without = Array.from({ length: 4 }, () => row({ views7d: 5000, hasText: false }))
    const report = buildInsights([...withText, ...without], opts)
    const insight = report.insights.find((i) => i.dimension === 'text')!
    expect(insight.evidence).toBe('hint')
    expect(insight.title).toMatch(/vídeos com texto na tela/)
    expect(report.experiments.some((e) => e.id.startsWith('exp-confirm') && /com texto na tela/.test(e.title))).toBe(true)

    const close = buildInsights([...Array.from({ length: 4 }, () => row({ views7d: 5200, hasText: true })), ...without], opts)
    expect(close.insights.find((i) => i.dimension === 'text')).toBeUndefined()
  })

  it('never mixes platforms or projects in one comparison, and compares platforms with a caveat', () => {
    const yt = Array.from({ length: 4 }, () => row({ views7d: 2000, platformId: 'youtube' as PlatformId, durationSeconds: 20 }))
    const tt = Array.from({ length: 4 }, () => row({ views7d: 20_000, platformId: 'tiktok' as PlatformId, durationSeconds: 50 }))
    const report = buildInsights([...yt, ...tt], opts)
    // Duration differs only because platforms differ: no duration insight (each segment has one duration).
    expect(report.insights.find((i) => i.dimension === 'duration')).toBeUndefined()
    const platform = report.insights.find((i) => i.dimension === 'platform')!
    expect(platform.title).toMatch(/MMA, o TikTok costuma dar mais/)
    expect(platform.detail).toMatch(/Cada rede conta visualização de um jeito/)
    expect(report.experiments.some((e) => e.title === 'Experimente MMA no Instagram')).toBe(true)
  })

  it('ignores posts without a 7-day number and points at contents worth a new version', () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row({ views7d: 1000 + i * 100 })),
      row({ views7d: 50_000, contentName: 'Nocaute absurdo' }),
      row({ views7d: null, contentName: 'Novo' })
    ]
    const report = buildInsights(rows, opts)
    expect(report).toMatchObject({ usable: 7, total: 8 })
    expect(report.revisit[0]).toMatchObject({ contentName: 'Nocaute absurdo', platformsUsed: ['youtube'] })
    expect(report.revisit[0]!.reason).toMatch(/TikTok e Instagram/)
  })

  it('compares the current period with the previous one', () => {
    const rows = [
      row({ views7d: 3000, publishedAt: new Date(NOW - 10 * DAY).toISOString() }),
      row({ views7d: 5000, publishedAt: new Date(NOW - 20 * DAY).toISOString() }),
      row({ views7d: 1000, publishedAt: new Date(NOW - 40 * DAY).toISOString() }),
      row({ views7d: null, publishedAt: new Date(NOW - 2 * DAY).toISOString() })
    ]
    const c = comparePeriods(rows, 30, NOW)
    expect(c.current).toMatchObject({ posts: 3, medianViews7d: 4000, withViews7d: 2 })
    expect(c.previous).toMatchObject({ posts: 1, medianViews7d: 1000 })
    expect(median([1, 2, 3, 100])).toBe(2.5)
  })
})

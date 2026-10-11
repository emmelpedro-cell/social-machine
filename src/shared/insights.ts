import { DURATION_BUCKETS, durationBucket, engagementRate, type PerformanceRow } from './analytics'
import type { PlatformId } from './publishing'

/**
 * Trends and experiment ideas from the user's own history (Phase 7, no AI).
 *
 * Rules, from spec §12:
 * - compare like with like: views at the same age (7 days after publishing),
 *   within one project and one platform (similar audience, same view definition);
 * - medians, not averages (one viral post doesn't decide);
 * - always say how many posts support a claim, and call it a trend or a
 *   hypothesis — never a cause.
 */

export type Evidence = 'insufficient' | 'hint' | 'trend'

export const EVIDENCE_LABELS: Record<Evidence, string> = {
  insufficient: 'Poucos dados',
  hint: 'Indício',
  trend: 'Tendência'
}

/** Posts per group needed before saying anything, and for a "trend". */
export const MIN_PER_GROUP = 3
export const TREND_PER_GROUP = 8
/** Best group's median must beat the runner-up by this factor to be worth mentioning. */
export const MIN_RATIO = 1.25

export type InsightGroup = { key: string; label: string; n: number; median: number }

export type InsightDimension = 'duration' | 'hour' | 'weekday' | 'text' | 'format' | 'platform'

export type Insight = {
  id: string
  dimension: InsightDimension
  projectId: string | null
  platformId: PlatformId | null
  /** One-sentence finding, phrased as a trend. */
  title: string
  detail: string
  evidence: Evidence
  groups: InsightGroup[]
  /** Posts behind the comparison. */
  sample: number
}

export type Experiment = { id: string; projectId: string | null; platformId: PlatformId | null; title: string; why: string }

export type RevisitCandidate = {
  contentId: string
  contentName: string
  projectId: string | null
  reason: string
  platformsUsed: PlatformId[]
}

export type PeriodComparison = {
  days: number
  current: { posts: number; medianViews7d: number | null; withViews7d: number; engagement: number | null }
  previous: { posts: number; medianViews7d: number | null; withViews7d: number; engagement: number | null }
}

export type InsightReport = {
  insights: Insight[]
  experiments: Experiment[]
  revisit: RevisitCandidate[]
  /** Posts that have a 7-day number (what the comparisons can use). */
  usable: number
  total: number
}

const PLATFORM: Record<PlatformId, string> = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' }
const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
export const DAYPARTS: { key: string; label: string; from: number; to: number }[] = [
  { key: 'madrugada', label: 'madrugada (0–6 h)', from: 0, to: 6 },
  { key: 'manha', label: 'manhã (6–12 h)', from: 6, to: 12 },
  { key: 'tarde', label: 'tarde (12–18 h)', from: 12, to: 18 },
  { key: 'noite', label: 'noite (18–24 h)', from: 18, to: 24 }
]

export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const compact = (n: number) => new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(n)

type Options = { hourOf?: (iso: string) => number; weekdayOf?: (iso: string) => number; projectName?: (id: string | null) => string }

type Dim = { id: InsightDimension; key: (r: PerformanceRow) => string | null; label: (key: string) => string; noun: string }

function dimensions(o: Required<Options>): Dim[] {
  return [
    {
      id: 'duration',
      key: (r) => (r.durationSeconds === null ? null : durationBucket(r.durationSeconds)),
      label: (k) => `vídeos de ${DURATION_BUCKETS.find((b) => b.key === k)?.label ?? k}`,
      noun: 'duração'
    },
    {
      id: 'hour',
      key: (r) => {
        const h = o.hourOf(r.publishedAt)
        return DAYPARTS.find((d) => h >= d.from && h < d.to)!.key
      },
      label: (k) => `publicações de ${DAYPARTS.find((d) => d.key === k)!.label}`,
      noun: 'horário'
    },
    { id: 'weekday', key: (r) => String(o.weekdayOf(r.publishedAt)), label: (k) => `publicações de ${WEEKDAYS[Number(k)]}`, noun: 'dia da semana' },
    { id: 'text', key: (r) => (r.hasText === null ? null : r.hasText ? 'com' : 'sem'), label: (k) => `vídeos ${k} texto na tela`, noun: 'texto na tela' },
    { id: 'format', key: (r) => r.aspectRatio, label: (k) => `vídeos em ${k}`, noun: 'formato' }
  ]
}

function evidenceFor(groups: InsightGroup[]): Evidence {
  const smallest = Math.min(...groups.slice(0, 2).map((g) => g.n))
  if (smallest < MIN_PER_GROUP) return 'insufficient'
  return smallest >= TREND_PER_GROUP ? 'trend' : 'hint'
}

function groupBy(rows: readonly PerformanceRow[], key: (r: PerformanceRow) => string | null, label: (k: string) => string): InsightGroup[] {
  const map = new Map<string, number[]>()
  for (const r of rows) {
    const k = key(r)
    if (k === null || r.views7d === null) continue
    map.set(k, [...(map.get(k) ?? []), r.views7d])
  }
  return [...map.entries()].map(([k, values]) => ({ key: k, label: label(k), n: values.length, median: median(values) })).sort((a, b) => b.median - a.median)
}

/**
 * Builds the report. Rows should be published posts (any period); only posts
 * with a 7-day number enter comparisons.
 */
export function buildInsights(rows: readonly PerformanceRow[], options: Options = {}): InsightReport {
  const o: Required<Options> = {
    hourOf: options.hourOf ?? ((iso) => new Date(iso).getHours()),
    weekdayOf: options.weekdayOf ?? ((iso) => new Date(iso).getDay()),
    projectName: options.projectName ?? ((id) => (id ? 'este projeto' : 'sem projeto'))
  }
  const usableRows = rows.filter((r) => r.views7d !== null)
  const insights: Insight[] = []
  const experiments: Experiment[] = []

  // Segments: project × platform (same audience, same definition of a view).
  const segments = new Map<string, PerformanceRow[]>()
  for (const r of usableRows) {
    const k = `${r.projectId ?? 'none'}|${r.platformId}`
    segments.set(k, [...(segments.get(k) ?? []), r])
  }
  for (const [k, list] of segments) {
    const [projectKey, platformId] = k.split('|') as [string, PlatformId]
    const projectId = projectKey === 'none' ? null : projectKey
    const where = `${o.projectName(projectId)} no ${PLATFORM[platformId]}`
    for (const dim of dimensions(o)) {
      const groups = groupBy(list, dim.key, dim.label)
      if (groups.length < 2) continue
      const [best, second] = groups as [InsightGroup, InsightGroup]
      const evidence = evidenceFor(groups)
      const ratio = second.median > 0 ? best.median / second.median : Infinity
      const sample = groups.reduce((n, g) => n + g.n, 0)
      if (evidence === 'insufficient') {
        // Suggest tests only for choices the user controls in the editor/queue.
        if (dim.id !== 'duration' && dim.id !== 'text' && dim.id !== 'hour') continue
        experiments.push({
          id: `exp-${k}-${dim.id}`,
          projectId,
          platformId,
          title: `Teste ${dim.noun} em ${where}`,
          why: `Há poucos vídeos para comparar ${groups.map((g) => `${g.label} (${g.n})`).join(' e ')}. Publique pelo menos ${MIN_PER_GROUP} de cada, em condições parecidas, para ver se há diferença.`
        })
        continue
      }
      if (ratio < MIN_RATIO) continue
      insights.push({
        id: `ins-${k}-${dim.id}`,
        dimension: dim.id,
        projectId,
        platformId,
        title: `Em ${where}, ${best.label} tiveram mais visualizações em 7 dias`,
        detail:
          `Mediana de ${compact(best.median)} (${best.n} vídeos) contra ${compact(second.median)} para ${second.label} (${second.n} vídeos). ` +
          (evidence === 'trend'
            ? 'É uma tendência no seu histórico, não prova de causa: outros fatores (tema, lance, dia) também mudam.'
            : 'Ainda é um indício: confirme com mais publicações antes de mudar sua rotina.'),
        evidence,
        groups,
        sample
      })
      if (evidence === 'hint') {
        experiments.push({
          id: `exp-confirm-${k}-${dim.id}`,
          projectId,
          platformId,
          title: `Confirme: ${best.label} em ${where}`,
          why: `Alterne ${best.label} e ${second.label} nas próximas publicações, mantendo o resto parecido, até ter ${TREND_PER_GROUP} de cada.`
        })
      }
    }
  }

  // Platforms within a project (definitions differ: compare as a trend, with the caveat).
  const byProject = new Map<string, PerformanceRow[]>()
  for (const r of usableRows) byProject.set(r.projectId ?? 'none', [...(byProject.get(r.projectId ?? 'none') ?? []), r])
  for (const [projectKey, list] of byProject) {
    const projectId = projectKey === 'none' ? null : projectKey
    const groups = groupBy(list, (r) => r.platformId, (k) => PLATFORM[k as PlatformId])
    if (groups.length < 2) continue
    const [best, second] = groups as [InsightGroup, InsightGroup]
    const evidence = evidenceFor(groups)
    if (evidence === 'insufficient' || (second.median > 0 && best.median / second.median < MIN_RATIO)) continue
    insights.push({
      id: `ins-${projectKey}-platform`,
      dimension: 'platform',
      projectId,
      platformId: null,
      title: `Em ${o.projectName(projectId)}, o ${best.label} costuma dar mais visualizações em 7 dias`,
      detail: `Mediana de ${compact(best.median)} (${best.n} vídeos) contra ${compact(second.median)} no ${second.label} (${second.n}). Cada rede conta visualização de um jeito; compare a tendência, não o número.`,
      evidence,
      groups,
      sample: groups.reduce((n, g) => n + g.n, 0)
    })
  }

  // Platforms never tried for a project that has posts elsewhere.
  const platformsByProject = new Map<string, Set<PlatformId>>()
  for (const r of rows) {
    const k = r.projectId ?? 'none'
    if (!platformsByProject.has(k)) platformsByProject.set(k, new Set())
    platformsByProject.get(k)!.add(r.platformId)
  }
  for (const [projectKey, used] of platformsByProject) {
    if (projectKey === 'none' || used.size === 0) continue
    const missing = (['youtube', 'tiktok', 'instagram'] as PlatformId[]).filter((p) => !used.has(p))
    for (const p of missing) {
      experiments.push({
        id: `exp-new-${projectKey}-${p}`,
        projectId: projectKey,
        platformId: p,
        title: `Experimente ${o.projectName(projectKey)} no ${PLATFORM[p]}`,
        why: `Você ainda não publicou ${o.projectName(projectKey)} no ${PLATFORM[p]}. Publicar as mesmas versões lá mostra se essa audiência responde diferente.`
      })
    }
  }

  // Contents worth a new version: top quarter of their project by 7-day views or engagement.
  const revisit: RevisitCandidate[] = []
  const contents = new Map<string, PerformanceRow[]>()
  for (const r of rows) contents.set(r.contentId, [...(contents.get(r.contentId) ?? []), r])
  for (const [projectKey, list] of byProject) {
    if (list.length < 4) continue
    const views = list.map((r) => r.views7d!).sort((a, b) => a - b)
    const p75 = views[Math.floor(views.length * 0.75)]!
    const seen = new Set<string>()
    for (const r of [...list].sort((a, b) => b.views7d! - a.views7d!)) {
      if (r.views7d! < p75 || seen.has(r.contentId)) continue
      seen.add(r.contentId)
      const used = [...new Set((contents.get(r.contentId) ?? []).map((x) => x.platformId))]
      const engagement = engagementRate(r.latest)
      revisit.push({
        contentId: r.contentId,
        contentName: r.contentName,
        projectId: projectKey === 'none' ? null : projectKey,
        platformsUsed: used,
        reason:
          `Entre os 25% mais vistos de ${o.projectName(projectKey === 'none' ? null : projectKey)} (${compact(r.views7d!)} em 7 dias no ${PLATFORM[r.platformId]}` +
          `${engagement !== null ? `, engajamento ${(engagement * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : ''}). ` +
          (used.length < 3 ? `Ainda não foi para ${(['youtube', 'tiktok', 'instagram'] as PlatformId[]).filter((p) => !used.includes(p)).map((p) => PLATFORM[p]).join(' e ')}; ` : '') +
          'uma nova versão (outro formato, corte ou título) pode render de novo.'
      })
    }
  }

  const order: Record<Evidence, number> = { trend: 0, hint: 1, insufficient: 2 }
  insights.sort((a, b) => order[a.evidence] - order[b.evidence] || b.sample - a.sample)
  return { insights, experiments: dedupe(experiments).slice(0, 12), revisit: revisit.slice(0, 10), usable: usableRows.length, total: rows.length }
}

function dedupe<T extends { id: string }>(list: T[]): T[] {
  const seen = new Set<string>()
  return list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)))
}

/** The last `days` days against the `days` before them (by publication date). */
export function comparePeriods(rows: readonly PerformanceRow[], days: number, now = Date.now()): PeriodComparison {
  const DAY = 86_400_000
  const stats = (list: PerformanceRow[]) => {
    const v7 = list.filter((r) => r.views7d !== null).map((r) => r.views7d!)
    let interactions = 0
    let views = 0
    for (const r of list) {
      if (engagementRate(r.latest) === null) continue
      interactions += r.latest!.likes! + r.latest!.comments! + r.latest!.shares!
      views += r.latest!.views!
    }
    return { posts: list.length, medianViews7d: v7.length ? median(v7) : null, withViews7d: v7.length, engagement: views > 0 ? interactions / views : null }
  }
  const t = (r: PerformanceRow) => new Date(r.publishedAt).getTime()
  return {
    days,
    current: stats(rows.filter((r) => t(r) >= now - days * DAY)),
    previous: stats(rows.filter((r) => t(r) < now - days * DAY && t(r) >= now - 2 * days * DAY))
  }
}

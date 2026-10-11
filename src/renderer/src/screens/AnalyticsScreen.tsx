import { useMemo, useState } from 'react'
import {
  aggregate,
  DURATION_BUCKETS,
  durationBucket,
  ENGAGEMENT_FORMULA,
  groupRows,
  inPeriod,
  type Aggregate,
  type AnalyticsPeriod,
  type PerformanceRow
} from '../../../shared/analytics'
import type { PlatformId } from '../../../shared/publishing'
import type { Project } from '../../../shared/schemas'
import { api, unwrap } from '../api'
import { BarList, type BarItem } from '../analytics/BarList'
import { ContentPerformance } from '../analytics/ContentPerformance'
import { fmtCount, fmtDuration, fmtPercent, UNAVAILABLE } from '../analytics/format'
import { useAnalyticsOverview } from '../analytics/useAnalytics'
import type { NoticeState } from '../components/Notice'
import { formatRelative } from '../format'
import { PLATFORM_LABEL } from '../publishing/PublicationsList'

type Props = {
  projects: Project[]
  contentId: string | null
  onOpenContent: (contentId: string | null) => void
  onOpenAccounts: () => void
  onNotice: (n: NoticeState) => void
  onError: (e: unknown) => void
}

type Dimension = 'platform' | 'project' | 'account' | 'format' | 'duration'
type Measure = 'views' | 'avgViews' | 'engagement' | 'followers' | 'watch'

const DIMENSIONS: { id: Dimension; label: string }[] = [
  { id: 'platform', label: 'Plataforma' },
  { id: 'project', label: 'Projeto' },
  { id: 'account', label: 'Conta' },
  { id: 'format', label: 'Formato' },
  { id: 'duration', label: 'Duração' }
]

const MEASURES: { id: Measure; label: string }[] = [
  { id: 'views', label: 'Visualizações (total)' },
  { id: 'avgViews', label: 'Visualizações por publicação' },
  { id: 'engagement', label: 'Engajamento' },
  { id: 'followers', label: 'Seguidores/inscritos ganhos' },
  { id: 'watch', label: 'Tempo assistido' }
]

const PERIODS: { id: AnalyticsPeriod; label: string }[] = [
  { id: '7d', label: '7 dias' },
  { id: '30d', label: '30 dias' },
  { id: '90d', label: '90 dias' },
  { id: 'all', label: 'Tudo' }
]

function measureValue(a: Aggregate, m: Measure): { value: number | null; display: string; detail: string } {
  const cov = (n: number) => `dados de ${n} de ${a.publications} publicação(ões)`
  switch (m) {
    case 'views':
      return { value: a.totals.views.sum, display: fmtCount(a.totals.views.sum), detail: cov(a.totals.views.withData) }
    case 'avgViews':
      return { value: a.averageViews, display: fmtCount(a.averageViews), detail: cov(a.totals.views.withData) }
    case 'engagement':
      return { value: a.engagement.rate, display: fmtPercent(a.engagement.rate), detail: `${ENGAGEMENT_FORMULA}; ${cov(a.engagement.withData)}` }
    case 'followers':
      return { value: a.totals.followersGained.sum, display: fmtCount(a.totals.followersGained.sum), detail: cov(a.totals.followersGained.withData) }
    case 'watch':
      return { value: a.totals.watchTimeSeconds.sum, display: fmtDuration(a.totals.watchTimeSeconds.sum), detail: cov(a.totals.watchTimeSeconds.withData) }
  }
}

/** Analytics: everything computed from real snapshots; missing data is shown as unavailable, never as zero. */
export function AnalyticsScreen({ projects, contentId, onOpenContent, onOpenAccounts, onNotice, onError }: Props) {
  const { data } = useAnalyticsOverview()
  const [period, setPeriod] = useState<AnalyticsPeriod>('30d')
  const [project, setProject] = useState('all')
  const [platform, setPlatform] = useState<'all' | PlatformId>('all')
  const [account, setAccount] = useState('all')
  const [dimension, setDimension] = useState<Dimension>('platform')
  const [measure, setMeasure] = useState<Measure>('avgViews')
  const [sort, setSort] = useState<'views' | 'engagement' | 'recent'>('views')
  const [refreshing, setRefreshing] = useState(false)

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const rows = useMemo(
    () =>
      (data?.rows ?? []).filter(
        (r) =>
          inPeriod(r, period) &&
          (project === 'all' || (project === 'none' ? r.projectId === null : r.projectId === project)) &&
          (platform === 'all' || r.platformId === platform) &&
          (account === 'all' || r.accountId === account)
      ),
    [data, period, project, platform, account]
  )
  const total = useMemo(() => aggregate(rows), [rows])

  const bars: BarItem[] = useMemo(() => {
    const keyOf: Record<Dimension, (r: PerformanceRow) => string> = {
      platform: (r) => r.platformId,
      project: (r) => r.projectId ?? 'none',
      account: (r) => r.accountId,
      format: (r) => r.aspectRatio ?? 'unknown',
      duration: (r) => durationBucket(r.durationSeconds)
    }
    const labelOf = (key: string, sample: PerformanceRow): { label: string; marker?: React.ReactNode } => {
      switch (dimension) {
        case 'platform':
          return { label: PLATFORM_LABEL[key as PlatformId], marker: <span className={`cal-dot pf-${key}`} aria-hidden="true" /> }
        case 'project': {
          const p = projectById.get(key)
          return { label: p?.name ?? 'Sem projeto', marker: <span className="project-dot" style={{ background: p?.color ?? 'var(--text-faint)' }} aria-hidden="true" /> }
        }
        case 'account':
          return { label: `${sample.accountName}`, marker: <span className={`cal-dot pf-${sample.platformId}`} aria-hidden="true" /> }
        case 'format':
          return { label: key === 'unknown' ? 'Desconhecido' : key }
        case 'duration':
          return { label: DURATION_BUCKETS.find((b) => b.key === key)?.label ?? 'Desconhecida' }
      }
    }
    const groups = [...groupRows(rows, keyOf[dimension]).entries()].map(([key, list]) => {
      const a = aggregate(list)
      const m = measureValue(a, measure)
      return { key, ...labelOf(key, list[0]!), ...m, sortValue: m.value ?? -1 }
    })
    if (dimension === 'duration') groups.sort((a, b) => DURATION_BUCKETS.findIndex((x) => x.key === a.key) - DURATION_BUCKETS.findIndex((x) => x.key === b.key))
    else groups.sort((a, b) => b.sortValue - a.sortValue)
    return groups
  }, [rows, dimension, measure, projectById])

  const tableGroups = useMemo(() => {
    const keyOf = (r: PerformanceRow) =>
      dimension === 'platform'
        ? r.platformId
        : dimension === 'project'
          ? (r.projectId ?? 'none')
          : dimension === 'account'
            ? r.accountId
            : dimension === 'format'
              ? (r.aspectRatio ?? 'unknown')
              : durationBucket(r.durationSeconds)
    return [...groupRows(rows, keyOf).entries()].map(([key, list]) => ({ key, a: aggregate(list) }))
  }, [rows, dimension])

  const contents = useMemo(() => {
    const list = [...groupRows(rows, (r) => r.contentId).entries()].map(([id, list]) => {
      const a = aggregate(list)
      return {
        id,
        name: list[0]!.contentName,
        projectId: list[0]!.projectId,
        platforms: [...new Set(list.map((r) => r.platformId))],
        a,
        latestPublished: list.map((r) => r.publishedAt).sort().at(-1)!
      }
    })
    list.sort((x, y) =>
      sort === 'views'
        ? (y.a.totals.views.sum ?? -1) - (x.a.totals.views.sum ?? -1)
        : sort === 'engagement'
          ? (y.a.engagement.rate ?? -1) - (x.a.engagement.rate ?? -1)
          : y.latestPublished.localeCompare(x.latestPublished)
    )
    return list.slice(0, 25)
  }, [rows, sort])

  if (contentId) {
    return <ContentPerformance contentId={contentId} projects={projects} onBack={() => onOpenContent(null)} onNotice={onNotice} onError={onError} />
  }

  async function refresh() {
    setRefreshing(true)
    try {
      const result = await unwrap(api.analytics.refresh())
      if (result.accounts === 0) onNotice({ tone: 'info', text: 'Nenhuma conta com métricas automáticas e vídeos publicados.' })
      else if (result.errors.length) onNotice({ tone: 'error', text: result.errors.join(' ') })
      else onNotice({ tone: 'success', text: `Métricas atualizadas (${result.publications} publicação(ões)).` })
    } catch (e) {
      onError(e)
    } finally {
      setRefreshing(false)
    }
  }

  const accounts = data?.accounts ?? []
  const problems = accounts.filter((a) => a.automatic && a.error)
  const manualAccounts = accounts.filter((a) => !a.automatic)
  const tiles: { label: string; value: string; detail: string; testId: string; title?: string }[] = [
    { label: 'Publicações', value: String(total.publications), detail: 'publicadas no período', testId: 'tile-publications' },
    { label: 'Visualizações', value: fmtCount(total.totals.views.sum), detail: `${total.totals.views.withData} de ${total.publications} com dado`, testId: 'tile-views' },
    {
      label: 'Engajamento',
      value: fmtPercent(total.engagement.rate),
      detail: `${total.engagement.withData} de ${total.publications} com os 4 números`,
      testId: 'tile-engagement',
      title: ENGAGEMENT_FORMULA
    },
    {
      label: 'Seguidores/inscritos ganhos',
      value: fmtCount(total.totals.followersGained.sum),
      detail: `${total.totals.followersGained.withData} de ${total.publications} com dado`,
      testId: 'tile-followers'
    },
    { label: 'Tempo assistido', value: fmtDuration(total.totals.watchTimeSeconds.sum), detail: `${total.totals.watchTimeSeconds.withData} de ${total.publications} com dado`, testId: 'tile-watch' },
    { label: 'Curtidas', value: fmtCount(total.totals.likes.sum), detail: `${total.totals.likes.withData} de ${total.publications} com dado`, testId: 'tile-likes' },
    { label: 'Comentários', value: fmtCount(total.totals.comments.sum), detail: `${total.totals.comments.withData} de ${total.publications} com dado`, testId: 'tile-comments' },
    { label: 'Compartilhamentos', value: fmtCount(total.totals.shares.sum), detail: `${total.totals.shares.withData} de ${total.publications} com dado`, testId: 'tile-shares' }
  ]

  const groupLabel = (key: string) => {
    if (dimension === 'platform') return PLATFORM_LABEL[key as PlatformId]
    if (dimension === 'project') return projectById.get(key)?.name ?? 'Sem projeto'
    if (dimension === 'account') return accounts.find((x) => x.accountId === key)?.accountName ?? key
    if (dimension === 'format') return key === 'unknown' ? 'Desconhecido' : key
    return DURATION_BUCKETS.find((b) => b.key === key)?.label ?? 'Desconhecida'
  }

  return (
    <div className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Desempenho</p>
          <h1>Analytics</h1>
        </div>
        <button type="button" className="btn btn-ghost" onClick={refresh} disabled={refreshing} data-testid="analytics-refresh">
          {refreshing ? 'Atualizando…' : 'Atualizar métricas'}
        </button>
      </header>

      <div className="filter-row" role="group" aria-label="Filtros">
        <div className="segmented" role="tablist" aria-label="Período">
          {PERIODS.map((p) => (
            <button key={p.id} type="button" className={period === p.id ? 'is-active' : ''} onClick={() => setPeriod(p.id)} data-testid={`period-${p.id}`}>
              {p.label}
            </button>
          ))}
        </div>
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Projeto" data-testid="analytics-project">
          <option value="all">Todos os projetos</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="none">Sem projeto</option>
        </select>
        <select value={platform} onChange={(e) => setPlatform(e.target.value as 'all' | PlatformId)} aria-label="Plataforma" data-testid="analytics-platform">
          <option value="all">Todas as plataformas</option>
          {(['youtube', 'tiktok', 'instagram'] as PlatformId[]).map((p) => (
            <option key={p} value={p}>
              {PLATFORM_LABEL[p]}
            </option>
          ))}
        </select>
        <select value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Conta" data-testid="analytics-account">
          <option value="all">Todas as contas</option>
          {accounts.map((a) => (
            <option key={a.accountId} value={a.accountId}>
              {a.accountName}
            </option>
          ))}
        </select>
      </div>

      {problems.map((a) => (
        <div key={a.accountId} className="banner banner-error" role="alert" data-testid="metrics-problem">
          <span>
            <strong>{a.accountName}:</strong> {a.error}
          </span>
          {/conect/i.test(a.error ?? '') && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenAccounts}>
              Abrir Contas
            </button>
          )}
        </div>
      ))}

      {data && data.rows.length === 0 && (
        <section className="panel">
          <p className="lead">Nada publicado ainda.</p>
          <p className="muted small">
            As métricas aparecem aqui depois da primeira publicação. YouTube: coletadas automaticamente pela API. TikTok e Instagram: você informa os números
            na página de desempenho do conteúdo.
          </p>
        </section>
      )}

      <section className="tiles analytics-tiles" aria-label="Resumo">
        {tiles.map((t) => (
          <div key={t.testId} className="tile" data-testid={t.testId} title={t.title}>
            <span className={`tile-value${t.value === UNAVAILABLE ? ' is-unavailable' : ''}`}>{data ? t.value : '–'}</span>
            <span className="tile-label">{t.label}</span>
            <span className="tile-detail small muted">{t.detail}</span>
          </div>
        ))}
      </section>

      <section className="panel">
        <div className="panel-head wrap">
          <h2>Comparar por</h2>
          <div className="segmented" role="tablist" aria-label="Agrupar por">
            {DIMENSIONS.map((d) => (
              <button key={d.id} type="button" className={dimension === d.id ? 'is-active' : ''} onClick={() => setDimension(d.id)} data-testid={`dimension-${d.id}`}>
                {d.label}
              </button>
            ))}
          </div>
          <select value={measure} onChange={(e) => setMeasure(e.target.value as Measure)} aria-label="Métrica" data-testid="analytics-measure">
            {MEASURES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        {bars.length === 0 ? (
          <p className="muted small">Nenhuma publicação no período e filtros escolhidos.</p>
        ) : (
          <BarList items={bars} label={`${MEASURES.find((m) => m.id === measure)!.label} por ${DIMENSIONS.find((d) => d.id === dimension)!.label.toLowerCase()}`} testId="compare-bars" />
        )}
        {tableGroups.length > 0 && (
          <div className="table-scroll">
            <table className="data-table" data-testid="compare-table">
              <thead>
                <tr>
                  <th scope="col">{DIMENSIONS.find((d) => d.id === dimension)!.label}</th>
                  <th scope="col">Publicações</th>
                  <th scope="col">Visualizações</th>
                  <th scope="col">Por publicação</th>
                  <th scope="col">Curtidas</th>
                  <th scope="col">Comentários</th>
                  <th scope="col">Compart.</th>
                  <th scope="col" title={ENGAGEMENT_FORMULA}>
                    Engajamento
                  </th>
                  <th scope="col">Seguidores</th>
                  <th scope="col">Tempo assistido</th>
                </tr>
              </thead>
              <tbody>
                {tableGroups.map(({ key, a }) => (
                  <tr key={key}>
                    <th scope="row">{groupLabel(key)}</th>
                    <td>{a.publications}</td>
                    <td className={a.totals.views.sum === null ? 'is-unavailable' : ''}>{fmtCount(a.totals.views.sum, true)}</td>
                    <td className={a.averageViews === null ? 'is-unavailable' : ''}>{fmtCount(a.averageViews, true)}</td>
                    <td className={a.totals.likes.sum === null ? 'is-unavailable' : ''}>{fmtCount(a.totals.likes.sum, true)}</td>
                    <td className={a.totals.comments.sum === null ? 'is-unavailable' : ''}>{fmtCount(a.totals.comments.sum, true)}</td>
                    <td className={a.totals.shares.sum === null ? 'is-unavailable' : ''}>{fmtCount(a.totals.shares.sum, true)}</td>
                    <td className={a.engagement.rate === null ? 'is-unavailable' : ''}>{fmtPercent(a.engagement.rate)}</td>
                    <td className={a.totals.followersGained.sum === null ? 'is-unavailable' : ''}>{fmtCount(a.totals.followersGained.sum, true)}</td>
                    <td className={a.totals.watchTimeSeconds.sum === null ? 'is-unavailable' : ''}>{fmtDuration(a.totals.watchTimeSeconds.sum)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          Somas usam só publicações com o número disponível (a cobertura aparece ao passar o mouse). Visualizações não têm a mesma definição em cada rede:
          compare tendências entre plataformas, não números absolutos.
        </p>
      </section>

      <div className="analytics-grid">
        <section className="panel">
          <div className="panel-head wrap">
            <h2>Conteúdos</h2>
            <div className="segmented" role="tablist" aria-label="Ordenar por">
              {(
                [
                  ['views', 'Mais vistos'],
                  ['engagement', 'Engajamento'],
                  ['recent', 'Recentes']
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" className={sort === id ? 'is-active' : ''} onClick={() => setSort(id)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {contents.length === 0 ? (
            <p className="muted small">Nenhum conteúdo publicado no período.</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table is-clickable" data-testid="content-table">
                <thead>
                  <tr>
                    <th scope="col">Conteúdo</th>
                    <th scope="col">Destinos</th>
                    <th scope="col">Visualizações</th>
                    <th scope="col">Engajamento</th>
                    <th scope="col">Publicado</th>
                  </tr>
                </thead>
                <tbody>
                  {contents.map((c) => (
                    <tr key={c.id} onClick={() => onOpenContent(c.id)} data-testid="content-row" data-name={c.name}>
                      <th scope="row">
                        <button type="button" className="link-btn" onClick={() => onOpenContent(c.id)}>
                          <span className="project-dot" style={{ background: projectById.get(c.projectId ?? '')?.color ?? 'var(--text-faint)' }} aria-hidden="true" />
                          {c.name}
                        </button>
                      </th>
                      <td>
                        {c.platforms.map((p) => (
                          <span key={p} className={`platform-badge pf-${p}`}>
                            {PLATFORM_LABEL[p]}
                          </span>
                        ))}
                      </td>
                      <td className={c.a.totals.views.sum === null ? 'is-unavailable' : ''}>{fmtCount(c.a.totals.views.sum, true)}</td>
                      <td className={c.a.engagement.rate === null ? 'is-unavailable' : ''}>{fmtPercent(c.a.engagement.rate)}</td>
                      <td className="muted">{formatRelative(c.latestPublished)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="analytics-side">
          <section className="panel" data-testid="followers-panel">
            <h2>Seguidores por conta</h2>
            {accounts.length === 0 && <p className="muted small">Nenhuma conta.</p>}
            <ul className="followers-list">
              {accounts.map((a) => {
                const change = a.followers !== null && a.followersFirst ? a.followers - a.followersFirst.value : null
                return (
                  <li key={a.accountId} data-testid="followers-item" data-account={a.accountName}>
                    <span className={`platform-badge pf-${a.platformId}`}>{PLATFORM_LABEL[a.platformId]}</span>
                    <span className="followers-name">{a.accountName}</span>
                    <span className={`followers-value${a.followers === null ? ' is-unavailable' : ''}`}>
                      {a.automatic ? fmtCount(a.followers) : 'manual'}
                    </span>
                    {change !== null && change !== 0 && a.followersFirst && (
                      <span className="small muted followers-change">
                        {change > 0 ? '+' : ''}
                        {fmtCount(change)} desde {formatRelative(a.followersFirst.at)}
                      </span>
                    )}
                    <span className="small muted followers-checked">
                      {a.automatic ? (a.checkedAt ? `atualizado ${formatRelative(a.checkedAt)}` : 'ainda não coletado') : 'sem API: informe por publicação'}
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
          <section className="panel">
            <h2 className="small-heading">De onde vêm os números</h2>
            <ul className="planned small">
              <li>YouTube: visualizações, curtidas e comentários pela API de dados (atualizados a cada poucas horas nos primeiros dias).</li>
              <li>Tempo assistido, compartilhamentos, inscritos ganhos e retenção pelo YouTube Analytics, que costuma ter 1 a 3 dias de atraso.</li>
              {manualAccounts.length > 0 && <li>TikTok e Instagram: números que você copia do app da plataforma, marcados como “informado por você”.</li>}
              <li>Nada é estimado: o que falta aparece como “{UNAVAILABLE}”.</li>
            </ul>
          </section>
        </aside>
      </div>
      <p className="muted small">Engajamento = {ENGAGEMENT_FORMULA}, calculado só onde os quatro números existem (média ponderada pelas visualizações).</p>
    </div>
  )
}

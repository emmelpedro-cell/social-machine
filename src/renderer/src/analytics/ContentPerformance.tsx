import { useMemo } from 'react'
import {
  ENGAGEMENT_FORMULA,
  METRIC_KEYS,
  METRIC_LABELS,
  engagementRate,
  valueAt,
  type MetricKey,
  type PerformanceRow
} from '../../../shared/analytics'
import type { Project } from '../../../shared/schemas'
import { api } from '../api'
import type { NoticeState } from '../components/Notice'
import { formatDateTime } from '../format'
import { PLATFORM_LABEL } from '../publishing/PublicationsList'
import { fmtCount, fmtMetric, fmtPercent, UNAVAILABLE } from './format'
import { LineChart } from './LineChart'
import { ManualMetricsForm } from './ManualMetricsForm'
import { useContentAnalytics } from './useAnalytics'

type Props = {
  contentId: string
  projects: Project[]
  onBack: () => void
  onNotice: (n: NoticeState) => void
  onError: (e: unknown) => void
}

const MARKS: { label: string; hours: number }[] = [
  { label: 'Views em 24 h', hours: 24 },
  { label: 'Views em 7 dias', hours: 7 * 24 },
  { label: 'Views em 30 dias', hours: 30 * 24 }
]

const destination = (r: PerformanceRow) => `${PLATFORM_LABEL[r.platformId]} · ${r.accountName}`

/** One content across every destination: same internal id, any version. */
export function ContentPerformance({ contentId, projects, onBack, onNotice, onError }: Props) {
  const { data } = useContentAnalytics(contentId)
  const rows = data?.rows ?? []
  const project = projects.find((p) => p.id === rows[0]?.projectId)

  const series = useMemo(
    () =>
      [...rows]
        .sort((a, b) => (b.latest?.views ?? -1) - (a.latest?.views ?? -1))
        .map((r) => ({
          key: r.publicationId,
          label: destination(r),
          points: (data?.history[r.publicationId] ?? [])
            .filter((s) => s.views !== null)
            .map((s) => ({ t: new Date(s.capturedAt).getTime(), v: s.views! }))
        }))
        .filter((s) => s.points.length > 0),
    [rows, data]
  )

  if (!data) return <p className="muted">Carregando…</p>

  return (
    <div className="screen" data-testid="content-performance">
      <header className="screen-header">
        <div>
          <button type="button" className="link-btn small" onClick={onBack} data-testid="performance-back">
            ← Analytics
          </button>
          <h1>{rows[0]?.contentName ?? 'Conteúdo'}</h1>
          <p className="muted small">
            {project ? project.name : 'Sem projeto'} · {rows.length} destino(s) publicado(s). As versões diferentes do mesmo conteúdo contam juntas aqui.
          </p>
        </div>
      </header>

      {rows.length === 0 && <section className="panel muted">Este conteúdo ainda não foi publicado.</section>}

      {rows.length > 0 && (
        <section className="panel">
          <h2>Comparação entre destinos</h2>
          <div className="table-scroll">
            <table className="data-table" data-testid="performance-table">
              <thead>
                <tr>
                  <th scope="col">Métrica</th>
                  {rows.map((r) => (
                    <th key={r.publicationId} scope="col">
                      <span className={`platform-badge pf-${r.platformId}`}>{PLATFORM_LABEL[r.platformId]}</span> {r.accountName}
                      <span className="th-sub">{r.versionName ?? ''}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {METRIC_KEYS.map((key: MetricKey) => (
                  <tr key={key}>
                    <th scope="row">{METRIC_LABELS[key]}</th>
                    {rows.map((r) => {
                      const v = r.latest ? r.latest[key] : null
                      return (
                        <td key={r.publicationId} className={v === null ? 'is-unavailable' : ''} data-metric={key}>
                          {fmtMetric(key, v, true)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
                <tr>
                  <th scope="row" title={ENGAGEMENT_FORMULA}>
                    Engajamento <span className="muted small">ⓘ</span>
                  </th>
                  {rows.map((r) => {
                    const e = engagementRate(r.latest)
                    return (
                      <td key={r.publicationId} className={e === null ? 'is-unavailable' : ''}>
                        {fmtPercent(e)}
                      </td>
                    )
                  })}
                </tr>
                <tr>
                  <th scope="row">Retenção média (YouTube)</th>
                  {rows.map((r) => {
                    const pct = r.latest?.extra.averageViewPercentage ?? null
                    return (
                      <td key={r.publicationId} className={pct === null ? 'is-unavailable' : ''}>
                        {pct === null ? UNAVAILABLE : `${pct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% do vídeo`}
                      </td>
                    )
                  })}
                </tr>
                {MARKS.map((m) => (
                  <tr key={m.hours}>
                    <th scope="row">{m.label}</th>
                    {rows.map((r) => {
                      const v = valueAt(data.history[r.publicationId] ?? [], r.publishedAt, m.hours, 'views')
                      const reached = Date.now() >= new Date(r.publishedAt).getTime() + m.hours * 3_600_000
                      return (
                        <td key={r.publicationId} className={v === null ? 'is-unavailable' : ''}>
                          {v === null ? (reached ? UNAVAILABLE : 'ainda não') : fmtCount(v, true)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
                <tr className="row-meta">
                  <th scope="row">Publicado</th>
                  {rows.map((r) => (
                    <td key={r.publicationId}>{formatDateTime(r.publishedAt)}</td>
                  ))}
                </tr>
                <tr className="row-meta">
                  <th scope="row">Medido</th>
                  {rows.map((r) => (
                    <td key={r.publicationId} data-testid="measured">
                      {r.latest ? `${formatDateTime(r.latest.capturedAt)} · ${r.latest.source === 'manual' ? 'informado por você' : 'API'}` : 'sem medição'}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Engajamento = {ENGAGEMENT_FORMULA}; só é calculado quando os quatro números existem. TikTok e Instagram contam visualizações com regras
            próprias, então compare a tendência, não o número exato.
          </p>
          <div className="row wrap">
            {rows
              .filter((r) => r.externalUrl)
              .map((r) => (
                <button key={r.publicationId} type="button" className="btn btn-ghost btn-sm" onClick={() => api.publications.openUrl(r.publicationId).then(() => undefined, onError)}>
                  Abrir no {PLATFORM_LABEL[r.platformId]}
                </button>
              ))}
          </div>
        </section>
      )}

      {series.length > 0 && (
        <section className="panel">
          <h2>Visualizações ao longo do tempo</h2>
          <LineChart series={series} format={(v) => fmtCount(v)} label="Visualizações por destino ao longo do tempo" />
        </section>
      )}

      {rows.some((r) => r.manual) && (
        <section className="panel">
          <h2>Números das plataformas manuais</h2>
          {rows
            .filter((r) => r.manual)
            .map((r) => (
              <div key={r.publicationId} className="manual-block">
                <h3 className="small-heading">{destination(r)}</h3>
                <ManualMetricsForm row={r} history={data.history[r.publicationId] ?? []} onNotice={onNotice} onError={onError} />
              </div>
            ))}
        </section>
      )}
    </div>
  )
}

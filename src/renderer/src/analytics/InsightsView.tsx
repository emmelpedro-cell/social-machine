import { useMemo } from 'react'
import type { PerformanceRow } from '../../../shared/analytics'
import { buildInsights, comparePeriods, EVIDENCE_LABELS, MIN_PER_GROUP, TREND_PER_GROUP } from '../../../shared/insights'
import type { Project } from '../../../shared/schemas'
import { PLATFORM_LABEL } from '../publishing/PublicationsList'
import { BarList } from './BarList'
import { fmtCount, fmtPercent, UNAVAILABLE } from './format'

type Props = {
  rows: PerformanceRow[]
  projects: Project[]
  onOpenContent: (contentId: string) => void
}

function Delta({ current, previous, percent }: { current: number | null; previous: number | null; percent?: boolean }) {
  if (current === null || previous === null || previous === 0) return null
  const change = (current - previous) / previous
  return (
    <span className={`delta ${change >= 0 ? 'is-up' : 'is-down'}`}>
      {change >= 0 ? '▲' : '▼'} {Math.abs(change * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%{percent ? ' (relativo)' : ''}
    </span>
  )
}

/** Trends, experiments and contents worth revisiting, from the user's own history. No AI, no estimates. */
export function InsightsView({ rows, projects, onOpenContent }: Props) {
  const projectName = useMemo(() => {
    const map = new Map(projects.map((p) => [p.id, p.name]))
    return (id: string | null) => (id ? (map.get(id) ?? 'projeto removido') : 'conteúdos sem projeto')
  }, [projects])
  const report = useMemo(() => buildInsights(rows, { projectName }), [rows, projectName])
  const periods = useMemo(() => comparePeriods(rows, 30), [rows])

  return (
    <div className="insights" data-testid="insights">
      <section className="panel">
        <div className="panel-head wrap">
          <h2>Últimos 30 dias × 30 dias anteriores</h2>
        </div>
        <div className="tiles analytics-tiles">
          <div className="tile" data-testid="period-posts">
            <span className="tile-value">{periods.current.posts}</span>
            <span className="tile-label">Publicações</span>
            <span className="tile-detail small muted">
              antes: {periods.previous.posts} <Delta current={periods.current.posts} previous={periods.previous.posts} />
            </span>
          </div>
          <div className="tile" data-testid="period-views">
            <span className={`tile-value${periods.current.medianViews7d === null ? ' is-unavailable' : ''}`}>{fmtCount(periods.current.medianViews7d)}</span>
            <span className="tile-label">Mediana de visualizações em 7 dias</span>
            <span className="tile-detail small muted">
              antes: {fmtCount(periods.previous.medianViews7d)} <Delta current={periods.current.medianViews7d} previous={periods.previous.medianViews7d} />
              <br />
              {periods.current.withViews7d} de {periods.current.posts} já com 7 dias
            </span>
          </div>
          <div className="tile" data-testid="period-engagement">
            <span className={`tile-value${periods.current.engagement === null ? ' is-unavailable' : ''}`}>{fmtPercent(periods.current.engagement)}</span>
            <span className="tile-label">Engajamento</span>
            <span className="tile-detail small muted">
              antes: {fmtPercent(periods.previous.engagement)} <Delta current={periods.current.engagement} previous={periods.previous.engagement} percent />
            </span>
          </div>
        </div>
        <p className="muted small">
          A comparação usa visualizações aos 7 dias de cada publicação, para que vídeos novos e antigos sejam medidos na mesma idade. Publicações com
          menos de 7 dias entram quando chegarem lá.
        </p>
      </section>

      <section className="panel" data-testid="insights-trends">
        <div className="panel-head wrap">
          <h2>Tendências no seu histórico</h2>
          <span className="muted small">
            {report.usable} de {report.total} publicações com número de 7 dias
          </span>
        </div>
        <p className="muted small">
          Cada comparação fica dentro de um projeto e de uma plataforma (mesma audiência, mesma forma de contar visualização) e usa a mediana. “Indício”
          precisa de pelo menos {MIN_PER_GROUP} vídeos por grupo; “Tendência”, de {TREND_PER_GROUP}. Nenhuma delas prova causa.
        </p>
        {report.insights.length === 0 ? (
          <p className="small" data-testid="insights-empty">
            Ainda não há dados suficientes para apontar tendências. Continue publicando e veja os experimentos sugeridos abaixo.
          </p>
        ) : (
          <ul className="insight-list">
            {report.insights.map((i) => (
              <li key={i.id} className="insight" data-testid="insight" data-evidence={i.evidence}>
                <div className="insight-head">
                  <span className={`evidence ev-${i.evidence}`}>{EVIDENCE_LABELS[i.evidence]}</span>
                  <strong>{i.title}</strong>
                </div>
                <p className="small muted">{i.detail}</p>
                <BarList
                  label={`Mediana de visualizações em 7 dias: ${i.title}`}
                  items={i.groups.map((g) => ({
                    key: g.key,
                    label: `${g.label} (${g.n})`,
                    value: g.median,
                    display: fmtCount(g.median),
                    detail: `mediana de ${g.n} vídeo(s)`,
                    marker: i.dimension === 'platform' ? <span className={`cal-dot pf-${g.key}`} aria-hidden="true" /> : undefined
                  }))}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="analytics-grid">
        <section className="panel" data-testid="insights-experiments">
          <h2>Experimentos sugeridos</h2>
          {report.experiments.length === 0 ? (
            <p className="muted small">Nenhum por enquanto.</p>
          ) : (
            <ul className="experiment-list">
              {report.experiments.map((e) => (
                <li key={e.id} data-testid="experiment">
                  <strong>
                    {e.platformId && <span className={`platform-badge pf-${e.platformId}`}>{PLATFORM_LABEL[e.platformId]}</span>} {e.title}
                  </strong>
                  <p className="small muted">{e.why}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">Sugestões para testar, não garantias de alcance. Mude uma coisa por vez para saber o que fez diferença.</p>
        </section>

        <section className="panel" data-testid="insights-revisit">
          <h2>Merecem uma nova versão</h2>
          {report.revisit.length === 0 ? (
            <p className="muted small">Aparece quando um projeto tiver pelo menos 4 publicações com 7 dias.</p>
          ) : (
            <ul className="experiment-list">
              {report.revisit.map((r) => (
                <li key={r.contentId}>
                  <button type="button" className="link-btn" onClick={() => onOpenContent(r.contentId)}>
                    {r.contentName}
                  </button>
                  <p className="small muted">{r.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {report.total === 0 && <p className="muted small">{UNAVAILABLE}: nada publicado ainda.</p>}
    </div>
  )
}

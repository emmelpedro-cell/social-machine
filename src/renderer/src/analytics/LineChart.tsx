import { useMemo, useRef, useState } from 'react'
import { SERIES_COLORS } from './format'

export type LineSeries = { key: string; label: string; points: { t: number; v: number }[] }

type Props = { series: LineSeries[]; format: (v: number) => string; label: string; height?: number }

const W = 720
const PAD = { top: 12, right: 16, bottom: 28, left: 52 }
const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' })
const dateTimeFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0]
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const ticks: number[] = []
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v)
  if (ticks[ticks.length - 1]! < max) ticks.push(ticks[ticks.length - 1]! + step)
  return ticks
}

/** Values at or before t (a step reading of snapshots: the last known number). */
function valueAtOrBefore(points: { t: number; v: number }[], t: number): number | null {
  let found: number | null = null
  for (const p of points) {
    if (p.t > t) break
    found = p.v
  }
  return found
}

/**
 * Snapshot history over time: 2px lines, end dots with a surface ring,
 * crosshair snapping to the nearest snapshot time, one tooltip for all series.
 * Up to four series (validated palette); the legend is always shown for 2+.
 */
export function LineChart({ series, format, label, height = 240 }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [hoverT, setHoverT] = useState<number | null>(null)
  const shown = series.slice(0, SERIES_COLORS.length)
  const { times, x, y, ticks, tMin, tMax } = useMemo(() => {
    const all = shown.flatMap((s) => s.points)
    const tMin = Math.min(...all.map((p) => p.t))
    const tMax = Math.max(...all.map((p) => p.t))
    const ticks = niceTicks(Math.max(...all.map((p) => p.v), 0))
    const yMax = ticks[ticks.length - 1] || 1
    const x = (t: number) => PAD.left + (tMax === tMin ? (W - PAD.left - PAD.right) / 2 : ((t - tMin) / (tMax - tMin)) * (W - PAD.left - PAD.right))
    const y = (v: number) => PAD.top + (1 - v / yMax) * (height - PAD.top - PAD.bottom)
    const times = [...new Set(all.map((p) => p.t))].sort((a, b) => a - b)
    return { times, x, y, ticks, tMin, tMax }
  }, [shown, height])

  if (times.length === 0) return null

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = svgRef.current!.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    let best = times[0]!
    for (const t of times) if (Math.abs(x(t) - px) < Math.abs(x(best) - px)) best = t
    setHoverT(best)
  }

  const xTicks = tMax === tMin ? [tMin] : [tMin, tMin + (tMax - tMin) / 2, tMax]

  return (
    <figure className="line-chart" aria-label={label}>
      {shown.length > 1 && (
        <figcaption className="chart-legend">
          {shown.map((s, i) => (
            <span key={s.key} className="legend-item">
              <span className="legend-line" style={{ background: SERIES_COLORS[i] }} aria-hidden="true" />
              {s.label}
            </span>
          ))}
        </figcaption>
      )}
      <div className="line-chart-frame">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${height}`}
          role="img"
          aria-label={label}
          onPointerMove={onMove}
          onPointerLeave={() => setHoverT(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="chart-grid" />
              <text x={PAD.left - 8} y={y(t)} className="chart-tick" textAnchor="end" dominantBaseline="middle">
                {format(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text key={i} x={x(t)} y={height - 8} className="chart-tick" textAnchor={i === 0 && xTicks.length > 1 ? 'start' : i === xTicks.length - 1 && xTicks.length > 1 ? 'end' : 'middle'}>
              {dateFmt.format(new Date(t))}
            </text>
          ))}
          {shown.map((s, i) => {
            const pts = s.points
            const d = pts.map((p, j) => `${j === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
            const last = pts[pts.length - 1]!
            return (
              <g key={s.key}>
                {pts.length > 1 && <path d={d} fill="none" stroke={SERIES_COLORS[i]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
                <circle cx={x(last.t)} cy={y(last.v)} r={4} fill={SERIES_COLORS[i]} stroke="var(--bg-panel)" strokeWidth={2} />
              </g>
            )
          })}
          {hoverT !== null && (
            <g>
              <line x1={x(hoverT)} x2={x(hoverT)} y1={PAD.top} y2={height - PAD.bottom} className="chart-crosshair" />
              {shown.map((s, i) => {
                const v = valueAtOrBefore(s.points, hoverT)
                return v === null ? null : <circle key={s.key} cx={x(hoverT)} cy={y(v)} r={4} fill={SERIES_COLORS[i]} stroke="var(--bg-panel)" strokeWidth={2} />
              })}
            </g>
          )}
        </svg>
        {hoverT !== null && (
          <div className="chart-tooltip is-inline" style={{ left: `${(x(hoverT) / W) * 100}%` }} role="tooltip">
            <span className="muted">{dateTimeFmt.format(new Date(hoverT))}</span>
            {shown.map((s, i) => {
              const v = valueAtOrBefore(s.points, hoverT)
              return (
                <span key={s.key} className="tooltip-row">
                  <span className="legend-line" style={{ background: SERIES_COLORS[i] }} aria-hidden="true" />
                  <strong>{v === null ? '—' : format(v)}</strong>
                  <span className="muted">{s.label}</span>
                </span>
              )
            })}
          </div>
        )}
      </div>
      {series.length > shown.length && <p className="muted small">Mostrando {shown.length} de {series.length} destinos; todos estão na tabela.</p>}
    </figure>
  )
}

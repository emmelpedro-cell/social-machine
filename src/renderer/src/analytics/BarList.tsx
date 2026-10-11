import { useState } from 'react'

export type BarItem = {
  key: string
  label: string
  /** null = no data for this group (shown as "indisponível", never as an empty bar). */
  value: number | null
  display: string
  /** Secondary line in the tooltip, e.g. coverage. */
  detail?: string
  /** A small identity mark (platform badge, project color) rendered before the label. */
  marker?: React.ReactNode
}

type Props = { items: BarItem[]; label: string; testId?: string }

/**
 * Horizontal bars for one measure across categories: single hue, thin bars
 * from one baseline, value at the tip, tooltip on hover/focus.
 */
export function BarList({ items, label, testId }: Props) {
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null)
  const max = Math.max(0, ...items.map((i) => i.value ?? 0))
  const hovered = hover ? items.find((i) => i.key === hover.key) : null
  return (
    <div className="bar-list" role="list" aria-label={label} data-testid={testId}>
      {items.map((item) => {
        const width = item.value !== null && max > 0 ? Math.max(0.5, (item.value / max) * 100) : 0
        return (
          <div
            key={item.key}
            role="listitem"
            tabIndex={0}
            className={`bar-row${hover?.key === item.key ? ' is-hover' : ''}`}
            onPointerMove={(e) => setHover({ key: item.key, x: e.clientX, y: e.clientY })}
            onPointerLeave={() => setHover(null)}
            onFocus={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setHover({ key: item.key, x: r.left + r.width / 2, y: r.top })
            }}
            onBlur={() => setHover(null)}
            aria-label={`${item.label}: ${item.display}${item.detail ? ` (${item.detail})` : ''}`}
            data-testid="bar-row"
            data-key={item.label}
            data-value={item.value ?? ''}
          >
            <span className="bar-label">
              {item.marker}
              <span className="bar-label-text">{item.label}</span>
            </span>
            <span className="bar-track">
              {item.value !== null ? (
                <>
                  <span className="bar-fill" style={{ width: `calc((100% - 90px) * ${(width / 100).toFixed(4)})` }} />
                  <span className="bar-value">{item.display}</span>
                </>
              ) : (
                <span className="bar-value is-unavailable">{item.display}</span>
              )}
            </span>
          </div>
        )
      })}
      {hover && hovered && (
        <div className="chart-tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }} role="tooltip">
          <strong>{hovered.display}</strong>
          <span>{hovered.label}</span>
          {hovered.detail && <span className="muted">{hovered.detail}</span>}
        </div>
      )}
    </div>
  )
}

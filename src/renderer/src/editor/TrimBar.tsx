import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { formatDuration } from '../../../shared/media'

type Props = {
  duration: number
  start: number
  end: number
  time: number
  onChange: (start: number, end: number) => void
  onSeek: (t: number) => void
}

const MIN_LENGTH = 0.2

/** Trim range over the whole clip, with draggable handles and a clickable playhead. */
export function TrimBar({ duration, start, end, time, onChange, onSeek }: Props) {
  const bar = useRef<HTMLDivElement>(null)
  const dragging = useRef<'start' | 'end' | 'seek' | null>(null)
  const pct = (t: number) => `${(t / duration) * 100}%`

  const timeAt = (e: ReactPointerEvent) => {
    const rect = bar.current!.getBoundingClientRect()
    return Math.max(0, Math.min(duration, ((e.clientX - rect.left) / rect.width) * duration))
  }

  const apply = (e: ReactPointerEvent) => {
    const t = Math.round(timeAt(e) * 100) / 100
    if (dragging.current === 'start') onChange(Math.min(t, end - MIN_LENGTH), end)
    else if (dragging.current === 'end') onChange(start, Math.max(t, start + MIN_LENGTH))
    else if (dragging.current === 'seek') onSeek(Math.max(start, Math.min(end, t)))
  }

  return (
    <div className="trim">
      <div
        ref={bar}
        className="trim-bar"
        onPointerDown={(e) => {
          const target = (e.target as HTMLElement).dataset['handle'] as 'start' | 'end' | undefined
          dragging.current = target ?? 'seek'
          e.currentTarget.setPointerCapture(e.pointerId)
          apply(e)
        }}
        onPointerMove={(e) => dragging.current && apply(e)}
        onPointerUp={() => (dragging.current = null)}
        data-testid="trim-bar"
      >
        <span className="trim-range" style={{ left: pct(start), width: pct(end - start) }} />
        <span className="trim-handle" data-handle="start" style={{ left: pct(start) }} aria-label="Início" role="slider" aria-valuenow={start} />
        <span className="trim-handle" data-handle="end" style={{ left: pct(end) }} aria-label="Fim" role="slider" aria-valuenow={end} />
        <span className="trim-playhead" style={{ left: pct(time) }} />
      </div>
      <div className="trim-labels small muted">
        <span>Início {formatPrecise(start)}</span>
        <span>
          Duração <strong data-testid="trim-duration">{formatPrecise(end - start)}</strong>
        </span>
        <span>Fim {formatPrecise(end)}</span>
      </div>
    </div>
  )
}

export function formatPrecise(seconds: number): string {
  const base = formatDuration(Math.floor(seconds))
  const tenths = Math.floor((seconds % 1) * 10)
  return `${base}.${tenths}`
}

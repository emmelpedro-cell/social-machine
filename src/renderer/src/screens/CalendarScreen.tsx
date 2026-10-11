import { useMemo, useState, type DragEvent } from 'react'
import type { QueueItem } from '../../../shared/publishing'
import type { Project } from '../../../shared/schemas'
import { dayKey } from '../../../shared/schedule'
import { api, unwrap } from '../api'
import type { NoticeState } from '../components/Notice'
import { formatDateTime } from '../format'
import { canReschedule, PLATFORM_LABEL, PublicationsList, statusText } from '../publishing/PublicationsList'
import { useAccounts } from '../publishing/usePublishing'
import { QueueFilters } from '../queue/QueueFilters'
import { applyFilter, itemTime, needsAttention, useQueue, type QueueFilter } from '../queue/useQueue'

type View = 'month' | 'week' | 'day'

type Props = {
  projects: Project[]
  onOpenQueue: () => void
  onNotice: (n: NoticeState) => void
  onError: (e: unknown) => void
}

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const monthTitle = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' })
const dayTitle = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const shortDay = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' })
const clock = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

/** The days shown for a view around an anchor date. */
function visibleDays(view: View, anchor: Date): Date[] {
  if (view === 'day') return [startOfDay(anchor)]
  if (view === 'week') {
    const start = addDays(startOfDay(anchor), -anchor.getDay())
    return Array.from({ length: 7 }, (_, i) => addDays(start, i))
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const start = addDays(first, -first.getDay())
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

/** Month, week and day views of everything scheduled or published; drag a post to another day to reschedule it. */
export function CalendarScreen({ projects, onOpenQueue, onNotice, onError }: Props) {
  const [view, setView] = useState<View>('month')
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()))
  const [filter, setFilter] = useState<QueueFilter>({ project: 'all', account: 'all' })
  const [selected, setSelected] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const days = useMemo(() => visibleDays(view, anchor), [view, anchor])
  const range = useMemo(() => ({ from: days[0]!, to: addDays(days[days.length - 1]!, 1) }), [days])
  const { items } = useQueue(range.from, range.to)
  const { accounts } = useAccounts()
  const projectColor = useMemo(() => new Map(projects.map((p) => [p.id, p.color])), [projects])

  const byDay = useMemo(() => {
    const map = new Map<string, QueueItem[]>()
    for (const i of applyFilter(items ?? [], filter)) {
      const key = dayKey(new Date(itemTime(i)))
      map.set(key, [...(map.get(key) ?? []), i])
    }
    for (const list of map.values()) list.sort((a, b) => itemTime(a).localeCompare(itemTime(b)))
    return map
  }, [items, filter])

  const selectedItem = items?.find((i) => i.id === selected) ?? null
  const today = dayKey(new Date())

  function move(step: number) {
    setAnchor((a) =>
      view === 'month' ? new Date(a.getFullYear(), a.getMonth() + step, 1) : addDays(a, step * (view === 'week' ? 7 : 1))
    )
  }

  const title =
    view === 'month'
      ? monthTitle.format(anchor)
      : view === 'week'
        ? `${shortDay.format(days[0]!)} – ${shortDay.format(days[6]!)}`
        : dayTitle.format(anchor)

  async function dropOn(day: Date, e: DragEvent) {
    e.preventDefault()
    setDropTarget(null)
    const id = e.dataTransfer.getData('text/x-publication')
    const item = items?.find((i) => i.id === id)
    if (!item || !canReschedule(item)) return
    // Keep the time of day; change the date.
    const old = new Date(item.scheduledAt ?? Date.now() + 3_600_000)
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), old.getHours(), old.getMinutes())
    if (dayKey(at) === dayKey(old)) return
    try {
      await unwrap(api.publications.reschedule(item.id, at.toISOString()))
      onNotice({ tone: 'success', text: `“${item.title ?? item.contentName}” em ${item.accountName} reagendada para ${formatDateTime(at.toISOString())}.` })
    } catch (error) {
      onError(error)
    }
  }

  const chip = (i: QueueItem) => {
    const movable = canReschedule(i)
    return (
      <button
        key={i.id}
        type="button"
        className={`cal-chip st-${i.status}${needsAttention(i) ? ' is-attention' : ''}${selected === i.id ? ' is-selected' : ''}`}
        style={{ borderLeftColor: (i.projectId && projectColor.get(i.projectId)) || 'var(--text-faint)' }}
        draggable={movable}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/x-publication', i.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onClick={() => setSelected(i.id)}
        title={`${PLATFORM_LABEL[i.platformId]} · ${i.accountName} · ${statusText(i)}${movable ? ' · arraste para outro dia' : ''}`}
        data-testid="cal-item"
        data-status={i.status}
        data-account={i.accountName}
      >
        <span className={`cal-dot pf-${i.platformId}`} aria-hidden="true" />
        <span className="cal-time">{clock.format(new Date(itemTime(i)))}</span>
        <span className="cal-name">{i.title ?? i.contentName}</span>
      </button>
    )
  }

  const dayCell = (day: Date, compact: boolean) => {
    const key = dayKey(day)
    const list = byDay.get(key) ?? []
    const outside = view === 'month' && day.getMonth() !== anchor.getMonth()
    const limit = compact ? 4 : 50
    return (
      <div
        key={key}
        className={`cal-cell${outside ? ' is-outside' : ''}${key === today ? ' is-today' : ''}${dropTarget === key ? ' is-drop' : ''}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('text/x-publication')) return
          e.preventDefault()
          setDropTarget(key)
        }}
        onDragLeave={() => setDropTarget((t) => (t === key ? null : t))}
        onDrop={(e) => dropOn(day, e)}
        data-testid="cal-day"
        data-day={key}
      >
        <button
          type="button"
          className="cal-daynum"
          onClick={() => {
            setAnchor(day)
            setView('day')
          }}
        >
          {view === 'week' ? `${WEEKDAYS[day.getDay()]} ${day.getDate()}` : day.getDate()}
        </button>
        <div className="cal-items">
          {list.slice(0, limit).map(chip)}
          {list.length > limit && (
            <button
              type="button"
              className="link-btn small"
              onClick={() => {
                setAnchor(day)
                setView('day')
              }}
            >
              +{list.length - limit}
            </button>
          )}
        </div>
      </div>
    )
  }

  const dayItems = byDay.get(dayKey(anchor)) ?? []

  return (
    <div className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Publicação</p>
          <h1>Calendário</h1>
        </div>
        <div className="row wrap">
          <QueueFilters filter={filter} onChange={setFilter} projects={projects} accounts={accounts} />
          <button type="button" className="btn btn-ghost" onClick={onOpenQueue}>
            Ver fila
          </button>
        </div>
      </header>

      <div className="cal-toolbar">
        <div className="row">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => move(-1)} aria-label="Anterior" data-testid="cal-prev">
            ‹
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAnchor(startOfDay(new Date()))}>
            Hoje
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => move(1)} aria-label="Próximo" data-testid="cal-next">
            ›
          </button>
          <h2 className="cal-title" data-testid="cal-title">
            {title}
          </h2>
        </div>
        <div className="segmented" role="tablist">
          {(['month', 'week', 'day'] as View[]).map((v) => (
            <button key={v} type="button" className={view === v ? 'is-active' : ''} onClick={() => setView(v)} data-testid={`cal-view-${v}`}>
              {v === 'month' ? 'Mês' : v === 'week' ? 'Semana' : 'Dia'}
            </button>
          ))}
        </div>
      </div>

      <div className="cal-layout">
        <div className="cal-body">
          {view === 'month' && (
            <div className="cal-month">
              {WEEKDAYS.map((w) => (
                <div key={w} className="cal-weekday">
                  {w}
                </div>
              ))}
              {days.map((d) => dayCell(d, true))}
            </div>
          )}
          {view === 'week' && <div className="cal-week">{days.map((d) => dayCell(d, false))}</div>}
          {view === 'day' && (
            <section className="panel" data-testid="cal-day-list">
              {dayItems.length === 0 ? (
                <p className="muted small">Nada neste dia.</p>
              ) : (
                <PublicationsList publications={dayItems} showContent onNotice={onNotice} onError={onError} />
              )}
            </section>
          )}
          <p className="muted small cal-legend">
            A cor da borda é o projeto. Arraste uma publicação agendada para outro dia para reagendar (mantém o horário). Vídeos já agendados no
            YouTube mudam só no YouTube Studio.
          </p>
        </div>
        {view !== 'day' && (
          <aside className="cal-detail panel" data-testid="cal-detail">
            {selectedItem ? (
              <>
                <h2 className="small-heading">Publicação</h2>
                <PublicationsList publications={[selectedItem]} showContent onNotice={onNotice} onError={onError} />
              </>
            ) : (
              <p className="muted small">Clique numa publicação para ver detalhes e ações.</p>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}

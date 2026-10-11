import { useMemo, useState } from 'react'
import type { QueueItem } from '../../../shared/publishing'
import type { Project } from '../../../shared/schemas'
import { dayKey } from '../../../shared/schedule'
import type { NoticeState } from '../components/Notice'
import { plural } from '../format'
import { PublicationsList } from '../publishing/PublicationsList'
import { useAccounts } from '../publishing/usePublishing'
import { PostingTimes } from '../queue/PostingTimes'
import { QueueFilters } from '../queue/QueueFilters'
import { applyFilter, needsAttention, useQueue, type QueueFilter } from '../queue/useQueue'

type Props = {
  projects: Project[]
  onOpenCalendar: () => void
  onNotice: (n: NoticeState) => void
  onError: (e: unknown) => void
}

const DAY = 86_400_000
const dayTitle = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })

function dayLabel(key: string): string {
  const today = dayKey(new Date())
  const tomorrow = dayKey(new Date(Date.now() + DAY))
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  const label = dayTitle.format(new Date(y, m - 1, d))
  return key === today ? `Hoje · ${label}` : key === tomorrow ? `Amanhã · ${label}` : label
}

/** Everything planned, sending and waiting for you, per destination. */
export function QueueScreen({ projects, onOpenCalendar, onNotice, onError }: Props) {
  const [range] = useState(() => ({ from: new Date(Date.now() - 7 * DAY), to: new Date(Date.now() + 90 * DAY) }))
  const { items } = useQueue(range.from, range.to)
  const { accounts } = useAccounts()
  const [filter, setFilter] = useState<QueueFilter>({ project: 'all', account: 'all' })

  const groups = useMemo(() => {
    const list = applyFilter(items ?? [], filter)
    const attention = list.filter(needsAttention)
    const sending = list.filter((i) => i.status === 'queued' || i.status === 'publishing')
    const upcoming = list
      .filter((i) => i.status === 'scheduled' && !i.fields.missed && i.scheduledAt)
      .sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))
    const byDay = new Map<string, QueueItem[]>()
    for (const i of upcoming) {
      const key = dayKey(new Date(i.scheduledAt!))
      byDay.set(key, [...(byDay.get(key) ?? []), i])
    }
    const published = list
      .filter((i) => i.status === 'published')
      .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
      .slice(0, 20)
    return { attention, sending, byDay: [...byDay.entries()], upcomingCount: upcoming.length, published }
  }, [items, filter])

  const listProps = { showContent: true, onNotice, onError }

  return (
    <div className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Publicação</p>
          <h1>Fila</h1>
        </div>
        <div className="row wrap">
          <QueueFilters filter={filter} onChange={setFilter} projects={projects} accounts={accounts} />
          <button type="button" className="btn btn-ghost" onClick={onOpenCalendar}>
            Ver calendário
          </button>
        </div>
      </header>

      <div className="queue-grid">
        <div className="queue-main">
          {groups.attention.length > 0 && (
            <section className="panel panel-attention" data-testid="queue-attention">
              <div className="panel-head">
                <h2>Precisa de você</h2>
                <span className="muted small">{plural(groups.attention.length, 'item', 'itens')}</span>
              </div>
              <PublicationsList publications={groups.attention} {...listProps} />
            </section>
          )}

          {groups.sending.length > 0 && (
            <section className="panel" data-testid="queue-sending">
              <div className="panel-head">
                <h2>Enviando</h2>
              </div>
              <PublicationsList publications={groups.sending} {...listProps} />
            </section>
          )}

          <section className="panel" data-testid="queue-upcoming">
            <div className="panel-head">
              <h2>Agendadas</h2>
              <span className="muted small">{plural(groups.upcomingCount, 'publicação', 'publicações')}</span>
            </div>
            {items === null && <p className="muted small">Carregando…</p>}
            {items && groups.upcomingCount === 0 && (
              <p className="muted small">Nada agendado. Na Biblioteca ou no Editor, abra “Publicar” numa versão e escolha “Agendar”.</p>
            )}
            {groups.byDay.map(([key, list]) => (
              <div key={key} className="queue-day" data-testid="queue-day" data-day={key}>
                <h3 className="small-heading">{dayLabel(key)}</h3>
                <PublicationsList publications={list} {...listProps} />
              </div>
            ))}
          </section>

          {groups.published.length > 0 && (
            <section className="panel" data-testid="queue-published">
              <div className="panel-head">
                <h2>Publicadas recentemente</h2>
              </div>
              <PublicationsList publications={groups.published} {...listProps} />
            </section>
          )}
        </div>

        <aside className="queue-side">
          <section className="panel">
            <div className="panel-head">
              <h2>Horários de postagem</h2>
            </div>
            <p className="muted small">
              Dias e horários preferidos de cada conta. O app usa para sugerir o próximo horário livre; não é uma promessa de alcance.
            </p>
            <PostingTimes accounts={accounts} onNotice={onNotice} onError={onError} />
          </section>
          <section className="panel">
            <h2 className="small-heading">Como o agendamento funciona</h2>
            <ul className="planned small">
              <li>YouTube pode agendar no próprio YouTube: o vídeo sobe na hora como privado e fica público sozinho no horário.</li>
              <li>Os outros agendamentos rodam no app: ele precisa estar aberto (pode ficar na bandeja) no horário.</li>
              <li>Se o computador estava desligado, a publicação não sai atrasada sem você: fica em “Precisa de você”.</li>
              <li>TikTok e Instagram: você recebe um aviso no horário para publicar no app da plataforma.</li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  )
}

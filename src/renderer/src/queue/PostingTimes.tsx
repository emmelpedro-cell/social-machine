import { useEffect, useState } from 'react'
import { WEEKDAY_LABELS, type Account, type QueueSettings, type Weekday } from '../../../shared/publishing'
import { api, unwrap } from '../api'
import type { NoticeState } from '../components/Notice'
import { PLATFORM_LABEL } from '../publishing/PublicationsList'

type Props = { accounts: Account[] | null; onNotice: (n: NoticeState) => void; onError: (e: unknown) => void }

/** Preferred posting days and times per account, used to suggest the next free slot. */
export function PostingTimes({ accounts, onNotice, onError }: Props) {
  const [settings, setSettings] = useState<QueueSettings[] | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  useEffect(() => {
    unwrap(api.queue.settings()).then(
      (list) => {
        setSettings(list)
        setDrafts(Object.fromEntries(list.map((s) => [s.accountId, s.times.join(', ')])))
      },
      () => setSettings([])
    )
  }, [accounts])

  if (!accounts || !settings) return <p className="muted small">Carregando…</p>
  if (accounts.length === 0) return <p className="muted small">Adicione contas em Contas para definir horários.</p>

  async function save(next: QueueSettings, message?: string) {
    try {
      const saved = await unwrap(api.queue.saveSettings(next))
      setSettings((list) => (list ?? []).map((s) => (s.accountId === saved.accountId ? saved : s)))
      setDrafts((d) => ({ ...d, [saved.accountId]: saved.times.join(', ') }))
      if (message) onNotice({ tone: 'success', text: message })
    } catch (e) {
      onError(e)
    }
  }

  function parseTimes(text: string): string[] | null {
    const parts = text.split(/[\s,;]+/).filter(Boolean)
    const out: string[] = []
    for (const part of parts) {
      const m = /^(\d{1,2})(?::|h)?(\d{2})?$/.exec(part)
      if (!m) return null
      const h = Number(m[1])
      const min = Number(m[2] ?? 0)
      if (h > 23 || min > 59) return null
      out.push(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`)
    }
    return out
  }

  return (
    <ul className="posting-times" data-testid="posting-times">
      {accounts.map((a) => {
        const s = settings.find((x) => x.accountId === a.id)
        if (!s) return null
        return (
          <li key={a.id} className="posting-time-item" data-testid="posting-account" data-account={a.displayName}>
            <div className="publication-head">
              <span className={`platform-badge pf-${a.platformId}`}>{PLATFORM_LABEL[a.platformId]}</span>
              <strong>{a.displayName}</strong>
              <label className="toggle small">
                <input type="checkbox" checked={s.enabled} onChange={(e) => save({ ...s, enabled: e.target.checked })} />
                <span>Usar</span>
              </label>
            </div>
            <div className="weekday-row" role="group" aria-label="Dias">
              {WEEKDAY_LABELS.map((label, day) => {
                const on = s.days.includes(day as Weekday)
                return (
                  <button
                    key={label}
                    type="button"
                    className={`chip${on ? ' is-active' : ''}`}
                    aria-pressed={on}
                    disabled={!s.enabled}
                    onClick={() => save({ ...s, days: on ? s.days.filter((d) => d !== day) : [...s.days, day as Weekday] })}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
            <div className="row">
              <input
                value={drafts[a.id] ?? ''}
                disabled={!s.enabled}
                onChange={(e) => setDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
                onBlur={() => {
                  const times = parseTimes(drafts[a.id] ?? '')
                  if (!times) {
                    onError(new Error('Use horários como 12:00, 19:30.'))
                    return
                  }
                  if (times.join(',') !== s.times.join(',')) void save({ ...s, times }, `Horários de ${a.displayName} salvos.`)
                }}
                placeholder="12:00, 19:00"
                aria-label="Horários"
                data-testid="posting-times-input"
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

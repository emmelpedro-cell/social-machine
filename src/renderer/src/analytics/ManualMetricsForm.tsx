import { useState } from 'react'
import type { MetricSnapshot, PerformanceRow } from '../../../shared/analytics'
import { fromLocalInput, toLocalInput } from '../../../shared/schedule'
import { api, unwrap } from '../api'
import type { NoticeState } from '../components/Notice'
import { formatDateTime } from '../format'
import { PLATFORM_LABEL } from '../publishing/PublicationsList'
import { fmtCount } from './format'

type Props = {
  row: PerformanceRow
  history: MetricSnapshot[]
  onNotice: (n: NoticeState) => void
  onError: (e: unknown) => void
}

const FIELDS = [
  ['views', 'Visualizações'],
  ['likes', 'Curtidas'],
  ['comments', 'Comentários'],
  ['shares', 'Compartilhamentos'],
  ['followersGained', 'Seguidores ganhos']
] as const

type Field = (typeof FIELDS)[number][0]

/** For TikTok/Instagram: the numbers shown in the platform's app, saved as "informado por você". */
export function ManualMetricsForm({ row, history, onNotice, onError }: Props) {
  const [values, setValues] = useState<Record<Field, string>>({ views: '', likes: '', comments: '', shares: '', followersGained: '' })
  const [when, setWhen] = useState(() => toLocalInput(new Date()))
  const [busy, setBusy] = useState(false)
  const manual = history.filter((s) => s.source === 'manual').slice().reverse()

  const parse = (text: string): number | null | 'invalid' => {
    const clean = text.trim().replace(/\./g, '').replace(/\s/g, '')
    if (!clean) return null
    const m = /^(\d+(?:,\d+)?)\s*(mil|k|m|mi)?$/i.exec(clean)
    if (!m) return 'invalid'
    const base = Number(m[1]!.replace(',', '.'))
    const unit = (m[2] ?? '').toLowerCase()
    return Math.round(base * (unit === 'k' || unit === 'mil' ? 1_000 : unit === 'm' || unit === 'mi' ? 1_000_000 : 1))
  }

  async function save() {
    const parsed = Object.fromEntries(FIELDS.map(([k]) => [k, parse(values[k])])) as Record<Field, number | null | 'invalid'>
    const bad = FIELDS.find(([k]) => parsed[k] === 'invalid')
    if (bad) return onError(new Error(`“${bad[1]}”: use só números (ex.: 12500, 12,5 mil ou 1,2 mi).`))
    const capturedAt = fromLocalInput(when)
    if (!capturedAt) return onError(new Error('Escolha quando os números foram lidos.'))
    setBusy(true)
    try {
      await unwrap(
        api.analytics.addManual({
          publicationId: row.publicationId,
          capturedAt,
          views: parsed.views as number | null,
          likes: parsed.likes as number | null,
          comments: parsed.comments as number | null,
          shares: parsed.shares as number | null,
          followersGained: parsed.followersGained as number | null,
          watchTimeSeconds: null,
          averageViewDurationSeconds: null
        })
      )
      setValues({ views: '', likes: '', comments: '', shares: '', followersGained: '' })
      onNotice({ tone: 'success', text: `Números de ${row.accountName} registrados.` })
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="manual-metrics" data-testid="manual-metrics" data-account={row.accountName}>
      <p className="small muted">
        {PLATFORM_LABEL[row.platformId]} não fornece métricas para este app. Copie os números que aparecem no app do {PLATFORM_LABEL[row.platformId]} (deixe em
        branco o que não souber). Eles ficam marcados como “informado por você”.
      </p>
      <div className="manual-grid">
        {FIELDS.map(([key, label]) => (
          <label key={key} className="field">
            <span>{label}</span>
            <input inputMode="numeric" value={values[key]} onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} data-testid={`manual-${key}`} />
          </label>
        ))}
        <label className="field">
          <span>Lidos em</span>
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} data-testid="manual-when" />
        </label>
      </div>
      <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy} data-testid="manual-metrics-save">
        Registrar números
      </button>
      {manual.length > 0 && (
        <ul className="manual-history small">
          {manual.map((s) => (
            <li key={s.id}>
              <span>
                {formatDateTime(s.capturedAt)} · {fmtCount(s.views)} visualizações
              </span>
              <button
                type="button"
                className="link-btn small"
                onClick={() => unwrap(api.analytics.deleteManual(s.id)).then(() => undefined, onError)}
                aria-label={`Apagar registro de ${formatDateTime(s.capturedAt)}`}
              >
                Apagar
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import type { ContentVersion } from '../../../shared/editor'
import type { ContentItem } from '../../../shared/media'
import {
  YOUTUBE_CATEGORIES,
  YOUTUBE_LIMITS,
  type Account,
  type DestinationInput,
  type PlatformId,
  type ScheduleMode,
  type YouTubePrivacy
} from '../../../shared/publishing'
import { fromLocalInput, toLocalInput } from '../../../shared/schedule'
import { formatDateTime } from '../format'
import type { Project } from '../../../shared/schemas'
import { api, ApiError, errorMessage, unwrap } from '../api'
import type { NoticeState } from '../components/Notice'
import { displayName } from '../media/format'
import { PLATFORM_LABEL } from './PublicationsList'
import { useAccounts } from './usePublishing'

type Props = {
  version: ContentVersion
  content: ContentItem
  project: Project | null
  onClose: () => void
  onOpenAccounts: () => void
  onNotice: (n: NoticeState) => void
}

const newRequestId = () => crypto.randomUUID()

function parseHashtags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((t) => t.trim())
        .filter((t) => t.replace('#', '').length > 0)
        .map((t) => (t.startsWith('#') ? t : `#${t}`))
    )
  ]
}

/**
 * Publish one version to several destinations. Each destination becomes its
 * own publication with its own status; manual platforms get a checklist.
 */
export function PublishDialog({ version, content, project, onClose, onOpenAccounts, onNotice }: Props) {
  const { accounts, platforms } = useAccounts()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [title, setTitle] = useState(displayName(content).replace(/\.[a-z0-9]{2,4}$/i, ''))
  const [caption, setCaption] = useState(project?.settings.captionTemplate ?? '')
  const [hashtags, setHashtags] = useState((project?.settings.defaultHashtags ?? []).join(' '))
  const [privacy, setPrivacy] = useState<YouTubePrivacy>('public')
  const [madeForKids, setMadeForKids] = useState<boolean | null>(null)
  const [categoryId, setCategoryId] = useState('17')
  const [notes, setNotes] = useState<Record<PlatformId, string[]> | null>(null)
  const [requestId] = useState(newRequestId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [repeatWarning, setRepeatWarning] = useState<string | null>(null)
  const [when, setWhen] = useState<'now' | 'schedule'>('now')
  const [scheduleAt, setScheduleAt] = useState(() => toLocalInput(new Date(Date.now() + 3_600_000)))
  const [ytMode, setYtMode] = useState<ScheduleMode>('platform')
  const [suggesting, setSuggesting] = useState(false)

  useEffect(() => {
    unwrap(api.publications.notes(version.id)).then(setNotes, () => setNotes(null))
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [version.id, onClose])

  // Preselect the connected accounts of the content's project.
  useEffect(() => {
    if (!accounts || selected.size > 0) return
    const mine = accounts.filter((a) => content.projectId && a.projectIds.includes(content.projectId) && a.connectionStatus === 'connected')
    if (mine.length) setSelected(new Set(mine.map((a) => a.id)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts])

  const ordered = useMemo(() => {
    const list = accounts ?? []
    const inProject = (a: Account) => Boolean(content.projectId && a.projectIds.includes(content.projectId))
    return [...list].sort((a, b) => Number(inProject(b)) - Number(inProject(a)) || a.displayName.localeCompare(b.displayName))
  }, [accounts, content.projectId])

  const chosen = ordered.filter((a) => selected.has(a.id))
  const hasYouTube = chosen.some((a) => a.platformId === 'youtube' && !a.manual)
  const tags = parseHashtags(hashtags)
  const hasManual = chosen.some((a) => a.manual || a.platformId !== 'youtube')

  /** The earliest posting slot free on every chosen account (from each account's preferred times). */
  async function suggestSlot() {
    if (chosen.length === 0) return setError('Escolha os destinos primeiro.')
    setSuggesting(true)
    setError(null)
    try {
      const lists = await Promise.all(chosen.map((a) => unwrap(api.queue.nextSlots(a.id, 20))))
      const common = lists[0]!.find((slot) => lists.every((l) => l.includes(slot)))
      const pick = common ?? lists.map((l) => l[0]).filter((x): x is string => Boolean(x)).sort().at(-1)
      if (!pick) setError('Nenhum horário preferencial configurado nessas contas. Configure em Fila → Horários de postagem.')
      else setScheduleAt(toLocalInput(new Date(pick)))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSuggesting(false)
    }
  }

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function submit(allowRepeat: boolean) {
    setError(null)
    if (chosen.length === 0) {
      setError('Escolha pelo menos um destino.')
      return
    }
    if (hasYouTube && madeForKids === null) {
      setError('Informe se o vídeo é “feito para crianças” (o YouTube exige essa resposta).')
      return
    }
    let scheduledAt: string | null = null
    if (when === 'schedule') {
      scheduledAt = fromLocalInput(scheduleAt)
      if (!scheduledAt || new Date(scheduledAt).getTime() < Date.now() + 60_000) {
        setError('Escolha um horário no futuro para agendar.')
        return
      }
    }
    const destinations: DestinationInput[] = chosen.map((a) => ({
      accountId: a.id,
      title: title.trim() || null,
      caption: caption.trim() || null,
      hashtags: tags,
      fields:
        a.platformId === 'youtube' && !a.manual
          ? {
              privacy,
              madeForKids: madeForKids ?? undefined,
              categoryId,
              tags: tags.map((t) => t.replace(/^#/, '')),
              ...(scheduledAt ? { scheduleMode: ytMode } : {})
            }
          : {},
      scheduledAt
    }))
    setBusy(true)
    try {
      const { created } = await unwrap(api.publications.create({ versionId: version.id, destinations, allowRepeat, requestId }))
      const queued = created.filter((p) => p.status === 'queued').length
      const manual = created.filter((p) => p.status === 'manual_pending').length
      onNotice({
        tone: 'success',
        text: scheduledAt
          ? `${created.length} publicação(ões) agendada(s) para ${formatDateTime(scheduledAt)}. Acompanhe na Fila.`
          : [
          queued ? `${queued} envio(s) na fila.` : '',
          manual ? `${manual} publicação(ões) manual(is): siga os passos na lista de publicações.` : ''
        ]
          .filter(Boolean)
          .join(' ')
      })
      onClose()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT' && /já foi publicada/.test(e.message)) setRepeatWarning(e.message)
      else setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const statusLabel = (a: Account) =>
    a.manual
      ? 'manual'
      : a.connectionStatus === 'connected'
        ? 'conectada'
        : a.connectionStatus === 'expired'
          ? 'login expirado'
          : 'desconectada'

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog publish-dialog" role="dialog" aria-labelledby="publish-title" data-testid="publish-dialog">
        <h2 id="publish-title">Publicar “{version.name}”</h2>
        <p className="muted small">
          {version.width}×{version.height} · cada destino vira uma publicação independente, com status próprio.
        </p>

        <div className="field">
          <span>Destinos</span>
          {accounts && accounts.length === 0 && (
            <p className="small">
              Nenhuma conta ainda.{' '}
              <button type="button" className="link-btn" onClick={onOpenAccounts}>
                Adicionar contas
              </button>
            </p>
          )}
          <ul className="destination-list">
            {ordered.map((a) => {
              const disabled = !a.manual && a.connectionStatus !== 'connected'
              return (
                <li key={a.id}>
                  <label className={`destination${disabled ? ' is-disabled' : ''}`}>
                    <input type="checkbox" checked={selected.has(a.id)} disabled={disabled} onChange={() => toggle(a.id)} data-testid="destination" data-account={a.displayName} />
                    <span className={`platform-badge pf-${a.platformId}`}>{PLATFORM_LABEL[a.platformId]}</span>
                    <span>{a.displayName}</span>
                    <span className="small muted">
                      {statusLabel(a)}
                      {content.projectId && a.projectIds.includes(content.projectId) ? ` · ${project?.name}` : ''}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
          {notes && chosen.length > 0 && (
            <ul className="publish-notes small muted">
              {[...new Set(chosen.map((a) => a.platformId))].flatMap((p) =>
                (notes[p] ?? []).map((n) => (
                  <li key={`${p}-${n}`}>
                    {PLATFORM_LABEL[p]}: {n}
                  </li>
                ))
              )}
            </ul>
          )}
        </div>

        <label className="field">
          <span>
            Título <em className="optional">{hasYouTube ? `obrigatório no YouTube, até ${YOUTUBE_LIMITS.title}` : 'usado no YouTube'}</em>
          </span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} data-testid="publish-title" />
        </label>
        <label className="field">
          <span>Legenda / descrição</span>
          <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={3} maxLength={5000} data-testid="publish-caption" />
        </label>
        <label className="field">
          <span>Hashtags</span>
          <input value={hashtags} onChange={(e) => setHashtags(e.target.value)} placeholder="#mma #ufc" data-testid="publish-hashtags" />
        </label>

        {hasYouTube && (
          <fieldset className="youtube-options">
            <legend>YouTube</legend>
            <div className="row wrap">
              <label className="inline-field">
                <span>Visibilidade</span>
                <select value={privacy} onChange={(e) => setPrivacy(e.target.value as YouTubePrivacy)} data-testid="publish-privacy">
                  <option value="public">Público</option>
                  <option value="unlisted">Não listado</option>
                  <option value="private">Privado</option>
                </select>
              </label>
              <label className="inline-field">
                <span>Categoria</span>
                <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                  {YOUTUBE_CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="field">
              <span>É feito para crianças?</span>
              <div className="row">
                <label className="toggle">
                  <input type="radio" name="kids" checked={madeForKids === false} onChange={() => setMadeForKids(false)} data-testid="kids-no" />
                  <span>Não</span>
                </label>
                <label className="toggle">
                  <input type="radio" name="kids" checked={madeForKids === true} onChange={() => setMadeForKids(true)} />
                  <span>Sim</span>
                </label>
              </div>
            </div>
          </fieldset>
        )}

        <fieldset className="youtube-options when-options">
          <legend>Quando</legend>
          <div className="row wrap">
            <label className="toggle">
              <input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} data-testid="when-now" />
              <span>Agora</span>
            </label>
            <label className="toggle">
              <input type="radio" name="when" checked={when === 'schedule'} onChange={() => setWhen('schedule')} data-testid="when-schedule" />
              <span>Agendar</span>
            </label>
          </div>
          {when === 'schedule' && (
            <>
              <div className="row wrap">
                <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} data-testid="schedule-at" />
                <button type="button" className="btn btn-ghost btn-sm" onClick={suggestSlot} disabled={suggesting} data-testid="suggest-slot">
                  {suggesting ? 'Procurando…' : 'Próximo horário livre'}
                </button>
              </div>
              {hasYouTube && (
                <label className="inline-field">
                  <span>No YouTube</span>
                  <select value={ytMode} onChange={(e) => setYtMode(e.target.value as ScheduleMode)} data-testid="schedule-mode">
                    <option value="platform">Agendar no próprio YouTube (envia agora como privado)</option>
                    <option value="local">Enviar no horário (o computador precisa estar ligado)</option>
                  </select>
                </label>
              )}
              <p className="small muted">
                {hasYouTube && ytMode === 'platform' && 'O YouTube publica sozinho no horário, mesmo com o computador desligado. '}
                {(hasManual || (hasYouTube && ytMode === 'local')) &&
                  'No horário, o app precisa estar aberto (pode ficar na bandeja). Se o computador estiver desligado, nada é publicado atrasado sem você: a publicação fica marcada para você decidir. '}
                {hasManual && 'Para TikTok e Instagram você recebe um aviso no horário para publicar.'}
              </p>
            </>
          )}
        </fieldset>

        {repeatWarning && (
          <div className="confirm" role="alertdialog">
            <p>{repeatWarning}</p>
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={() => submit(true)} disabled={busy}>
                Publicar de novo
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setRepeatWarning(null)}>
                Voltar
              </button>
            </div>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {platforms && !platforms.find((p) => p.id === 'youtube')?.configured && (
          <p className="small muted">Para enviar ao YouTube pelo app, configure e conecte o canal em Contas.</p>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" onClick={() => submit(false)} disabled={busy || chosen.length === 0} data-testid="publish-submit">
            {busy
              ? 'Enviando…'
              : when === 'schedule'
                ? chosen.length > 1
                  ? `Agendar em ${chosen.length} destinos`
                  : 'Agendar'
                : chosen.length > 1
                  ? `Publicar em ${chosen.length} destinos`
                  : 'Publicar'}
          </button>
        </div>
      </div>
    </div>
  )
}

import { useState } from 'react'
import { composeCaption, PUBLICATION_STATUS_LABELS, type PlatformId, type Publication, type PublicationSummary } from '../../../shared/publishing'
import { fromLocalInput, toLocalInput } from '../../../shared/schedule'
import { api, unwrap } from '../api'
import type { NoticeState } from '../components/Notice'
import { formatDateTime, formatRelative } from '../format'

export const PLATFORM_LABEL: Record<PlatformId, string> = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' }

/** Already uploaded and held by the platform until its time (YouTube publishAt): changed only on the platform. */
export function onPlatform(p: Pick<Publication, 'status' | 'fields' | 'externalPostId'>): boolean {
  return p.status === 'scheduled' && p.fields.scheduleMode === 'platform' && p.externalPostId !== null
}

/** Can be moved to another time from the app. */
export function canReschedule(p: Pick<Publication, 'status' | 'fields' | 'externalPostId'>): boolean {
  return (p.status === 'scheduled' && !onPlatform(p)) || p.status === 'draft'
}

/** Status label, with the schedule details that matter. */
export function statusText(p: Publication): string {
  if (p.status === 'scheduled' && p.fields.missed) return 'Horário perdido'
  if (onPlatform(p)) return 'Agendada no YouTube'
  return PUBLICATION_STATUS_LABELS[p.status]
}

type Props = {
  publications: PublicationSummary[] | null
  showContent?: boolean
  onNotice: (n: NoticeState) => void
  onError: (e: unknown) => void
}

export function PublicationsList({ publications, showContent, onNotice, onError }: Props) {
  const [confirming, setConfirming] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [rescheduling, setRescheduling] = useState<string | null>(null)
  const [newTime, setNewTime] = useState('')

  if (publications === null) return <p className="muted small">Carregando publicações…</p>
  if (publications.length === 0) return <p className="muted small">Nenhuma publicação ainda.</p>

  async function copyCaption(p: PublicationSummary) {
    const text = [p.title, composeCaption(p.caption, p.hashtags)].filter(Boolean).join('\n\n')
    try {
      await unwrap(api.app.copyText(text))
      onNotice({ tone: 'success', text: 'Título, legenda e hashtags copiados.' })
    } catch (e) {
      onError(e)
    }
  }

  async function confirmPublished(p: PublicationSummary) {
    try {
      await unwrap(api.publications.markPublished(p.id, url))
      setConfirming(null)
      setUrl('')
      onNotice({ tone: 'success', text: `Publicação em ${p.accountName} registrada.` })
    } catch (e) {
      onError(e)
    }
  }

  async function act(action: () => Promise<unknown>, done?: string) {
    try {
      await action()
      if (done) onNotice({ tone: 'success', text: done })
    } catch (e) {
      onError(e)
    }
  }

  function startReschedule(p: PublicationSummary) {
    const base = p.scheduledAt && new Date(p.scheduledAt).getTime() > Date.now() ? new Date(p.scheduledAt) : new Date(Date.now() + 3_600_000)
    setNewTime(toLocalInput(base))
    setRescheduling(p.id)
  }

  async function saveReschedule(p: PublicationSummary) {
    const iso = fromLocalInput(newTime)
    if (!iso) return onError(new Error('Escolha data e horário.'))
    await act(async () => {
      await unwrap(api.publications.reschedule(p.id, iso))
      setRescheduling(null)
    }, `Reagendada para ${formatDateTime(iso)}.`)
  }

  return (
    <ul className="publication-list" data-testid="publication-list">
      {publications.map((p) => (
        <li
          key={p.id}
          className={`publication-item status-${p.status}${p.fields.missed ? ' is-missed' : ''}`}
          data-testid="publication-item"
          data-status={p.status}
          data-account={p.accountName}
          data-missed={p.fields.missed ? 'true' : undefined}
        >
          <div className="publication-head">
            <span className={`platform-badge pf-${p.platformId}`}>{PLATFORM_LABEL[p.platformId]}</span>
            <strong>{p.accountName}</strong>
            <span className={`pub-status st-${p.status}`} data-testid="publication-status">
              {statusText(p)}
              {p.status === 'publishing' && p.fields.progress !== undefined && ` ${Math.round(p.fields.progress * 100)}%`}
            </span>
          </div>
          <p className="small muted">
            {showContent && `${p.contentName}${p.versionName ? ` · ${p.versionName}` : ''} · `}
            {p.title ? `“${p.title}” · ` : ''}
            {p.scheduledAt && p.status !== 'published' && p.status !== 'cancelled' ? (
              <span data-testid="publication-when">
                {p.fields.scheduleMode === 'platform' ? 'publica no YouTube em ' : 'para '}
                {formatDateTime(p.scheduledAt)}
              </span>
            ) : (
              formatRelative(p.publishedAt ?? p.updatedAt)
            )}
          </p>
          {p.fields.missed && p.status === 'scheduled' && (
            <p className="small hint">O horário passou com o app fechado, então nada foi publicado. Publique agora ou escolha outro horário.</p>
          )}
          {p.status === 'draft' && <p className="small muted">Pausada: não será publicada até você retomar.</p>}
          {onPlatform(p) && (
            <p className="small muted">O vídeo já está no YouTube como privado e fica público sozinho no horário, mesmo com o computador desligado.</p>
          )}
          {p.status === 'publishing' && (
            <div className="progress-track" aria-hidden="true">
              <div className="progress-fill" style={{ width: `${Math.round((p.fields.progress ?? 0) * 100)}%` }} />
            </div>
          )}
          {p.errorMessage && p.status === 'failed' && <p className="small form-error">{p.errorMessage}</p>}
          {p.status === 'manual_pending' && (
            <p className="small hint">
              Publique no {PLATFORM_LABEL[p.platformId]} com o arquivo da versão e a legenda; depois confirme aqui.
            </p>
          )}
          <div className="row wrap">
            {p.status === 'manual_pending' && (
              <>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => api.platforms.openUpload(p.platformId).then(() => undefined, onError)}>
                  Abrir {PLATFORM_LABEL[p.platformId]}
                </button>
                {p.versionId && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => api.versions.showInFolder(p.versionId!).then(() => undefined, onError)}>
                    Mostrar arquivo
                  </button>
                )}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyCaption(p)}>
                  Copiar legenda
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setConfirming(p.id)} data-testid="confirm-manual">
                  Já publiquei
                </button>
              </>
            )}
            {p.status === 'published' && p.externalUrl && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => api.publications.openUrl(p.id).then(() => undefined, onError)}>
                Abrir publicação
              </button>
            )}
            {(p.status === 'failed' || p.status === 'cancelled') && p.platformId === 'youtube' && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => unwrap(api.publications.retry(p.id)).then(() => undefined, onError)} data-testid="retry-publication">
                Tentar de novo
              </button>
            )}
            {canReschedule(p) && (
              <>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => act(() => unwrap(api.publications.publishNow(p.id)))} data-testid="publish-now">
                  Publicar agora
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => startReschedule(p)} data-testid="reschedule">
                  Reagendar
                </button>
                {p.status === 'scheduled' ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => act(() => unwrap(api.publications.pause(p.id)))} data-testid="pause">
                    Pausar
                  </button>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => act(() => unwrap(api.publications.resume(p.id)))} data-testid="resume">
                    Retomar
                  </button>
                )}
              </>
            )}
            {onPlatform(p) && p.externalUrl && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => api.publications.openUrl(p.id).then(() => undefined, onError)}>
                Abrir vídeo
              </button>
            )}
            {(p.status === 'queued' || p.status === 'publishing' || p.status === 'manual_pending' || canReschedule(p)) && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => unwrap(api.publications.cancel(p.id)).then(() => undefined, onError)}>
                Cancelar
              </button>
            )}
          </div>
          {rescheduling === p.id && (
            <div className="confirm row wrap">
              <input type="datetime-local" value={newTime} onChange={(e) => setNewTime(e.target.value)} data-testid="reschedule-time" />
              <button type="button" className="btn btn-primary btn-sm" onClick={() => saveReschedule(p)} data-testid="reschedule-save">
                Salvar horário
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRescheduling(null)}>
                Cancelar
              </button>
            </div>
          )}
          {confirming === p.id && (
            <div className="confirm">
              <label className="field">
                <span>
                  Link da publicação <em className="optional">opcional</em>
                </span>
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.tiktok.com/@…/video/…" data-testid="manual-url" />
              </label>
              <div className="row">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => confirmPublished(p)} data-testid="manual-save">
                  Registrar como publicada
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(null)}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

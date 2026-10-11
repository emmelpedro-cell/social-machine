import { useState } from 'react'
import { composeCaption, PUBLICATION_STATUS_LABELS, type PlatformId, type PublicationSummary } from '../../../shared/publishing'
import { api, unwrap } from '../api'
import type { NoticeState } from '../components/Notice'
import { formatRelative } from '../format'

export const PLATFORM_LABEL: Record<PlatformId, string> = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' }

type Props = {
  publications: PublicationSummary[] | null
  showContent?: boolean
  onNotice: (n: NoticeState) => void
  onError: (e: unknown) => void
}

export function PublicationsList({ publications, showContent, onNotice, onError }: Props) {
  const [confirming, setConfirming] = useState<string | null>(null)
  const [url, setUrl] = useState('')

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

  return (
    <ul className="publication-list" data-testid="publication-list">
      {publications.map((p) => (
        <li key={p.id} className={`publication-item status-${p.status}`} data-testid="publication-item" data-status={p.status} data-account={p.accountName}>
          <div className="publication-head">
            <span className={`platform-badge pf-${p.platformId}`}>{PLATFORM_LABEL[p.platformId]}</span>
            <strong>{p.accountName}</strong>
            <span className={`pub-status st-${p.status}`} data-testid="publication-status">
              {PUBLICATION_STATUS_LABELS[p.status]}
              {p.status === 'publishing' && p.fields.progress !== undefined && ` ${Math.round(p.fields.progress * 100)}%`}
            </span>
          </div>
          <p className="small muted">
            {showContent && `${p.contentName}${p.versionName ? ` · ${p.versionName}` : ''} · `}
            {p.title ? `“${p.title}” · ` : ''}
            {formatRelative(p.publishedAt ?? p.updatedAt)}
          </p>
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
            {(p.status === 'queued' || p.status === 'publishing' || p.status === 'manual_pending') && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => unwrap(api.publications.cancel(p.id)).then(() => undefined, onError)}>
                Cancelar
              </button>
            )}
          </div>
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

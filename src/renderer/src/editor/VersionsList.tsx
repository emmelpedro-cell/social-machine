import { useState } from 'react'
import { formatBytes, formatDuration } from '../../../shared/media'
import type { ContentVersion } from '../../../shared/editor'
import { api, unwrap } from '../api'
import type { NoticeState } from '../components/Notice'
import { formatRelative } from '../format'

export const versionThumbUrl = (v: ContentVersion) => `sm-media://vthumb/${v.id}?v=${encodeURIComponent(v.updatedAt)}`
export const versionUrl = (v: ContentVersion) => `sm-media://version/${v.id}?v=${encodeURIComponent(v.updatedAt)}`

type Props = {
  versions: ContentVersion[] | null
  onEditCopy?: (version: ContentVersion) => void
  onPublish?: (version: ContentVersion) => void
  onNotice: (n: NoticeState) => void
  onError: (e: unknown) => void
  compact?: boolean
}

const ENCODER_LABEL: Record<string, string> = {
  libopenh264: 'OpenH264',
  h264_nvenc: 'NVIDIA',
  h264_qsv: 'Intel',
  h264_amf: 'AMD',
  h264_mf: 'Media Foundation'
}

export function VersionsList({ versions, onEditCopy, onPublish, onNotice, onError, compact }: Props) {
  const [confirm, setConfirm] = useState<string | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)

  if (versions === null) return <p className="muted small">Carregando versões…</p>
  if (versions.length === 0) {
    return <p className="muted small">Nenhuma versão ainda. O original nunca é alterado: cada exportação vira uma versão.</p>
  }

  const remove = (v: ContentVersion, deleteFile: boolean) =>
    unwrap(api.versions.remove(v.id, deleteFile)).then(() => {
      setConfirm(null)
      onNotice({ tone: 'info', text: deleteFile ? `Versão “${v.name}” e o arquivo dela foram excluídos.` : `Versão “${v.name}” excluída. O arquivo foi mantido.` })
    }, onError)

  return (
    <ul className={`version-list${compact ? ' compact' : ''}`} data-testid="version-list">
      {versions.map((v) => (
        <li key={v.id} className={`version-item status-${v.status}`} data-testid="version-item" data-name={v.name} data-status={v.status}>
          <div className="version-row">
            <span className="version-thumb">{v.hasThumbnail && <img src={versionThumbUrl(v)} alt="" />}</span>
            <div className="version-main">
              <strong className="version-name">{v.name}</strong>
              <span className="small muted">
                {v.status === 'ready' &&
                  [
                    `${v.width}×${v.height}`,
                    v.aspectRatio,
                    formatDuration(v.durationSeconds),
                    formatBytes(v.fileSize),
                    v.encoder ? ENCODER_LABEL[v.encoder] ?? v.encoder : null
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                {v.status === 'rendering' && `Exportando… ${Math.round(v.progress * 100)}%`}
                {v.status === 'error' && <span className="form-error">{v.errorMessage}</span>}
                {v.status !== 'rendering' && ` · ${formatRelative(v.updatedAt)}`}
              </span>
              {v.status === 'rendering' && (
                <div className="progress-track" aria-hidden="true">
                  <div className="progress-fill" style={{ width: `${Math.round(v.progress * 100)}%` }} />
                </div>
              )}
            </div>
          </div>
          {playing === v.id && v.status === 'ready' && (
            <video className="version-player" src={versionUrl(v)} controls autoPlay data-testid="version-player" />
          )}
          <div className="row wrap version-actions">
            {v.status === 'ready' && (
              <>
                {onPublish && (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => onPublish(v)} data-testid="publish-version">
                    Publicar…
                  </button>
                )}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPlaying(playing === v.id ? null : v.id)}>
                  {playing === v.id ? 'Fechar' : 'Assistir'}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => api.versions.showInFolder(v.id).then(() => undefined, onError)}>
                  Mostrar na pasta
                </button>
              </>
            )}
            {onEditCopy && v.status !== 'rendering' && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onEditCopy(v)}>
                Editar como nova
              </button>
            )}
            {v.status === 'error' && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => unwrap(api.versions.retry(v.id)).then(() => undefined, onError)}>
                Tentar de novo
              </button>
            )}
            {v.status === 'rendering' && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => unwrap(api.versions.cancel(v.id)).then(() => undefined, onError)}>
                Cancelar
              </button>
            )}
            {v.status !== 'rendering' &&
              (confirm === v.id ? (
                <>
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(v, false)}>
                    Excluir versão
                  </button>
                  {v.status === 'ready' && (
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(v, true)}>
                      Excluir versão e arquivo
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>
                    Manter
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-ghost btn-sm btn-danger-text" onClick={() => setConfirm(v.id)}>
                  Excluir…
                </button>
              ))}
          </div>
        </li>
      ))}
    </ul>
  )
}

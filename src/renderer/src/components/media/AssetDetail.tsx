import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  aspectRatioLabel,
  formatBytes,
  formatChannels,
  formatDuration,
  formatFrameRate,
  ORIGIN_LABELS,
  WORKFLOW_LABELS,
  WORKFLOW_STATUSES,
  type ContentItem,
  type RelinkResult,
  type WorkflowStatus
} from '../../../../shared/media'
import type { Project } from '../../../../shared/schemas'
import { api, unwrap } from '../../api'
import { formatDateTime } from '../../format'
import { assetState, displayName, sourceUrl, STATE_LABEL } from '../../media/format'
import type { NoticeState } from '../Notice'
import { ProjectSelect } from '../ProjectSelect'
import { useVersions } from '../../editor/useVersions'
import { VersionsList } from '../../editor/VersionsList'
import { PublishDialog } from '../../publishing/PublishDialog'
import { PublicationsList } from '../../publishing/PublicationsList'
import { usePublications } from '../../publishing/usePublishing'
import type { ContentVersion } from '../../../../shared/editor'

type Props = {
  asset: ContentItem
  projects: Project[]
  onOpenEditor: () => void
  onOpenAccounts: () => void
  onOpenAnalytics?: (contentId: string) => void
  onClose: () => void
  onNotice: (n: NoticeState) => void
  onError: (e: unknown) => void
}

export function AssetDetail({ asset, projects, onOpenEditor, onOpenAccounts, onOpenAnalytics, onClose, onNotice, onError }: Props) {
  const { versions } = useVersions(asset.id)
  const { publications } = usePublications(asset.id)
  const [publishing, setPublishing] = useState<ContentVersion | null>(null)
  const state = assetState(asset)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [mismatch, setMismatch] = useState<string | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [title, setTitle] = useState(asset.title ?? '')

  useEffect(() => setTitle(asset.title ?? ''), [asset.title])

  const handleRelinkResult = (result: RelinkResult) => {
    if (result.status === 'mismatch') setMismatch(result.fileName)
    else if (result.status === 'relinked') {
      setMismatch(null)
      onNotice({
        tone: 'success',
        text: result.reprocessing ? `Localizado. “${result.asset.fileName}” está sendo analisado de novo.` : 'Arquivo localizado.'
      })
    }
  }

  const relink = () => unwrap(api.media.relink(asset.id)).then(handleRelinkResult, onError)
  const confirmRelink = () => unwrap(api.media.relinkConfirm(asset.id)).then(handleRelinkResult, onError)
  const retry = () => unwrap(api.media.retry(asset.id)).then(() => undefined, onError)
  const cancel = () => unwrap(api.media.cancel(asset.id)).then(() => undefined, onError)
  const showInFolder = () => unwrap(api.media.showInFolder(asset.id)).then(() => undefined, onError)
  const setWorkflow = (status: WorkflowStatus) =>
    unwrap(api.media.setWorkflowStatus([asset.id], status)).then(() => undefined, onError)
  const setProject = (projectId: string | null) =>
    unwrap(api.media.setProject([asset.id], projectId)).then(() => undefined, onError)
  const remove = () =>
    unwrap(api.media.remove(asset.id)).then(() => {
      onNotice({ tone: 'info', text: `“${asset.fileName}” saiu da biblioteca. O arquivo em si não foi tocado.` })
      onClose()
    }, onError)

  function saveTitle(event?: FormEvent) {
    event?.preventDefault()
    const next = title.trim() || null
    if (next === asset.title) return
    unwrap(api.media.setTitle(asset.id, next)).then(() => undefined, onError)
  }

  const canPreview = state === 'ready' && !previewFailed

  return (
    <aside className="asset-detail" aria-label={`Detalhes de ${displayName(asset)}`} data-testid="asset-detail">
      <header className="asset-detail-head">
        <div>
          <p className="eyebrow">{ORIGIN_LABELS[asset.origin]}</p>
          <h2 className="asset-detail-title">{displayName(asset)}</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar detalhes">
          ×
        </button>
      </header>

      <div className="preview">
        {canPreview && (
          <video
            src={sourceUrl(asset)}
            controls
            preload="metadata"
            onError={() => setPreviewFailed(true)}
            data-testid="preview-video"
          />
        )}
        {state === 'ready' && previewFailed && (
          <p className="preview-note">
            O player embutido não reproduz este formato ({asset.videoCodec}). O arquivo foi importado corretamente e pode
            ser usado normalmente.
          </p>
        )}
        {(state === 'importing' || state === 'queued') && (
          <p className="preview-note">
            <span className="spinner" aria-hidden="true" /> {STATE_LABEL[state]}
          </p>
        )}
        {state === 'missing' && (
          <p className="preview-note warn">
            O arquivo não está mais no último local conhecido. Se você o moveu ou renomeou, use <strong>Localizar</strong>.
            Arquivos renomeados dentro de uma pasta monitorada são reencontrados automaticamente.
          </p>
        )}
        {state === 'error' && (
          <p className="preview-note error" data-testid="asset-error">
            {asset.errorMessage}
          </p>
        )}
      </div>

      <div className="detail-controls">
        <form className="field" onSubmit={saveTitle}>
          <span>Título</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => saveTitle()}
            maxLength={200}
            placeholder={asset.fileName}
            data-testid="content-title"
          />
        </form>
        <label className="field">
          <span>Projeto</span>
          <ProjectSelect
            projects={projects}
            value={asset.projectId}
            onChange={setProject}
            label="Projeto do conteúdo"
            testId="content-project"
          />
        </label>
        <label className="field">
          <span>Status</span>
          <select
            value={asset.workflowStatus}
            onChange={(e) => setWorkflow(e.target.value as WorkflowStatus)}
            aria-label="Status do conteúdo"
            data-testid="content-workflow"
          >
            {WORKFLOW_STATUSES.map((s) => (
              <option key={s} value={s}>
                {WORKFLOW_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {mismatch && (
        <div className="confirm" role="alertdialog" aria-label="Confirmar localização">
          <p>
            “{mismatch}” não tem o mesmo conteúdo do arquivo original. Usar mesmo assim? Ele será analisado de novo e os
            dados técnicos deste item serão substituídos.
          </p>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={confirmRelink}>
              Usar este arquivo
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setMismatch(null)}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      <div className="row wrap">
        {state === 'ready' && (
          <button type="button" className="btn btn-primary" onClick={onOpenEditor} data-testid="open-editor">
            Abrir no editor
          </button>
        )}
        {(state === 'missing' || state === 'ready' || state === 'error') && (
          <button type="button" className={`btn ${state === 'missing' ? 'btn-primary' : 'btn-ghost'}`} onClick={relink} data-testid="relink">
            Localizar…
          </button>
        )}
        {state === 'error' && asset.availability === 'online' && (
          <button type="button" className="btn btn-ghost" onClick={retry}>
            Tentar de novo
          </button>
        )}
        {(state === 'importing' || state === 'queued') && (
          <button type="button" className="btn btn-ghost" onClick={cancel}>
            Cancelar importação
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={showInFolder}>
          Mostrar na pasta
        </button>
      </div>

      <dl className="facts compact" data-testid="asset-facts">
        <Fact label="Arquivo" value={STATE_LABEL[state]} />
        {asset.status === 'ready' && (
          <>
            <Fact label="Duração" value={formatDuration(asset.durationSeconds)} />
            <Fact label="Resolução" value={asset.width && asset.height ? `${asset.width} × ${asset.height}` : '—'} />
            <Fact label="Proporção" value={aspectRatioLabel(asset.width, asset.height)} />
            <Fact label="Quadros" value={formatFrameRate(asset.frameRate)} />
            <Fact label="Codec de vídeo" value={asset.videoCodec ?? '—'} />
            {asset.rotation ? <Fact label="Rotação" value={`${asset.rotation}°`} /> : null}
            <Fact
              label="Áudio"
              value={
                asset.audioCodec
                  ? [asset.audioCodec, asset.sampleRate ? `${asset.sampleRate} Hz` : '', formatChannels(asset.channels)]
                      .filter(Boolean)
                      .join(' · ')
                  : 'Sem áudio'
              }
            />
            <Fact label="Contêiner" value={asset.container?.split(',')[0] ?? '—'} />
            <Fact label="Taxa de bits" value={asset.bitRate ? `${Math.round(asset.bitRate / 1000)} kb/s` : '—'} />
          </>
        )}
        <Fact label="Tamanho" value={formatBytes(asset.fileSize)} />
        <Fact label="Origem" value={ORIGIN_LABELS[asset.origin]} />
        <Fact label="Local" value={<code className="path">{asset.sourcePath}</code>} />
        <Fact label="Importado" value={formatDateTime(asset.importedAt)} />
      </dl>

      <section className="detail-versions">
        <h3 className="small-heading">Versões</h3>
        <VersionsList versions={versions} compact onPublish={setPublishing} onNotice={onNotice} onError={onError} />
      </section>

      <section className="detail-versions" data-testid="detail-publications">
        <div className="row">
          <h3 className="small-heading">Publicações</h3>
          {onOpenAnalytics && (publications ?? []).some((p) => p.status === 'published') && (
            <button type="button" className="link-btn small" onClick={() => onOpenAnalytics(asset.id)} data-testid="open-performance">
              Ver desempenho
            </button>
          )}
        </div>
        <PublicationsList publications={publications} onNotice={onNotice} onError={onError} />
      </section>

      {publishing && (
        <PublishDialog
          version={publishing}
          content={asset}
          project={projects.find((p) => p.id === asset.projectId) ?? null}
          onClose={() => setPublishing(null)}
          onOpenAccounts={onOpenAccounts}
          onNotice={onNotice}
        />
      )}

      <div className="danger-zone">
        {confirmRemove ? (
          <div className="confirm">
            <p>Tirar “{displayName(asset)}” da biblioteca? O arquivo no disco não é apagado.</p>
            <div className="row">
              <button type="button" className="btn btn-danger" onClick={remove}>
                Tirar da biblioteca
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmRemove(false)}>
                Manter
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-ghost btn-danger-text" onClick={() => setConfirmRemove(true)}>
            Tirar da biblioteca…
          </button>
        )}
      </div>
    </aside>
  )
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

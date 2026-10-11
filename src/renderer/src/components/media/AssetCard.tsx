import { useState } from 'react'
import { EDITORIAL_LABELS, editorialState, type ContentItem } from '../../../../shared/media'
import type { Project } from '../../../../shared/schemas'
import { assetState, displayName, metaLine, STATE_LABEL, thumbnailUrl } from '../../media/format'

type Props = {
  asset: ContentItem
  project: Project | null
  selected: boolean
  checked: boolean
  versionCount: number
  onSelect: () => void
  onToggleCheck: (shift: boolean) => void
}

export function AssetCard({ asset, project, selected, checked, versionCount, onSelect, onToggleCheck }: Props) {
  const state = assetState(asset)
  const [thumbFailed, setThumbFailed] = useState(false)
  const showThumb = asset.hasThumbnail && !thumbFailed
  const vertical = asset.width !== null && asset.height !== null && asset.height > asset.width

  return (
    <div
      className={`asset-card state-${state}${selected ? ' is-selected' : ''}${checked ? ' is-checked' : ''}`}
      data-testid="asset-card"
      data-file-name={asset.fileName}
      data-state={state}
      data-workflow={asset.workflowStatus}
      data-editorial={editorialState(asset)}
    >
      <label className="asset-check" title="Selecionar">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => undefined}
          onClick={(e) => {
            e.stopPropagation()
            onToggleCheck(e.shiftKey)
          }}
          aria-label={`Selecionar ${displayName(asset)}`}
        />
      </label>
      <button type="button" className="asset-card-body" onClick={onSelect} aria-pressed={selected}>
        <span className={`asset-thumb${vertical ? ' is-vertical' : ''}`}>
          {showThumb ? (
            <img src={thumbnailUrl(asset)} alt="" loading="lazy" onError={() => setThumbFailed(true)} data-testid="asset-thumb" />
          ) : (
            <span className="asset-placeholder kind-video">
              <span className="placeholder-label">Vídeo</span>
            </span>
          )}
          {state !== 'ready' && (
            <span className={`asset-badge badge-${state}`} data-testid="asset-status">
              {(state === 'importing' || state === 'queued') && <span className="spinner" aria-hidden="true" />}
              {STATE_LABEL[state]}
            </span>
          )}
          {state === 'ready' && (
            <span
              className={`workflow-badge wf-${editorialState(asset)}`}
              data-testid="asset-workflow"
              title={asset.publishedCount > 0 ? `${asset.publishedCount} publicação(ões) no ar` : undefined}
            >
              {EDITORIAL_LABELS[editorialState(asset)]}
            </span>
          )}
        </span>
        <span className="asset-name" title={asset.fileName}>
          {displayName(asset)}
        </span>
        <span className="asset-meta" data-testid="asset-meta">
          {state === 'error' ? asset.errorMessage : metaLine(asset) || ' '}
        </span>
        <span className="asset-project">
          <span className="project-dot" style={{ background: project?.color ?? 'var(--text-faint)' }} aria-hidden="true" />
          {project?.name ?? 'Sem projeto'}
          {versionCount > 0 && (
            <span className="version-count" data-testid="asset-versions">
              {' '}
              · {versionCount} {versionCount === 1 ? 'versão' : 'versões'}
            </span>
          )}
        </span>
      </button>
    </div>
  )
}

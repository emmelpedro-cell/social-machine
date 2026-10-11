import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ORIGIN_LABELS,
  WORKFLOW_LABELS,
  WORKFLOW_STATUSES,
  type ContentItem,
  type ContentOrigin,
  type WorkflowStatus
} from '../../../shared/media'
import type { Project } from '../../../shared/schemas'
import { api, errorMessage, unwrap } from '../api'
import type { NoticeState } from '../components/Notice'
import { AssetCard } from '../components/media/AssetCard'
import { AssetDetail } from '../components/media/AssetDetail'
import { ImportProgress } from '../components/media/ImportProgress'
import { ToolsBanner } from '../components/media/ToolsBanner'
import { ProjectSelect } from '../components/ProjectSelect'
import { plural } from '../format'
import { assetState, displayName, importNotice } from '../media/format'
import type { MediaLibrary } from '../media/useMediaLibrary'

export type ProjectFilter = 'all' | 'none' | string
export type WorkflowFilter = 'active' | 'all' | WorkflowStatus

export type LibraryFilters = {
  project: ProjectFilter
  workflow: WorkflowFilter
}

type Props = {
  library: MediaLibrary
  projects: Project[]
  initialFilters: LibraryFilters
  versionCounts: Record<string, number>
  onOpenEditor: (contentId: string) => void
  onOpenAccounts: () => void
  onOpenAnalytics?: (contentId: string) => void
  onNotice: (n: NoticeState) => void
  onError: (e: unknown) => void
}

type OriginFilter = 'all' | ContentOrigin
type StateFilter = 'all' | 'issues' | 'importing'
type SortKey = 'added' | 'name' | 'duration'

const SORTS: Record<SortKey, (a: ContentItem, b: ContentItem) => number> = {
  added: (a, b) => b.importedAt.localeCompare(a.importedAt) || a.fileName.localeCompare(b.fileName),
  name: (a, b) => displayName(a).localeCompare(displayName(b), undefined, { numeric: true, sensitivity: 'base' }),
  duration: (a, b) => (b.durationSeconds ?? -1) - (a.durationSeconds ?? -1)
}

export function LibraryScreen({ library, projects, initialFilters, versionCounts, onOpenEditor, onOpenAccounts, onOpenAnalytics, onNotice, onError }: Props) {
  const { assets, queue, tools } = library
  const [query, setQuery] = useState('')
  const [project, setProject] = useState<ProjectFilter>(initialFilters.project)
  const [workflow, setWorkflow] = useState<WorkflowFilter>(initialFilters.workflow)
  const [origin, setOrigin] = useState<OriginFilter>('all')
  const [state, setState] = useState<StateFilter>('all')
  const [sort, setSort] = useState<SortKey>('added')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const lastChecked = useRef<string | null>(null)
  const [busy, setBusy] = useState(false)

  const toolsReady = tools?.ok === true
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const selected = assets?.find((a) => a.id === selectedId) ?? null
  const missingCount = assets?.filter((a) => a.availability === 'missing').length ?? 0
  // A project that no longer exists falls back to "all".
  const effectiveProject = project !== 'all' && project !== 'none' && !projectById.has(project) ? 'all' : project
  const importProjectId = effectiveProject !== 'all' && effectiveProject !== 'none' ? effectiveProject : null

  // Re-check file locations whenever the library is opened.
  useEffect(() => {
    void api.media.checkAvailability()
  }, [])

  const visible = useMemo(() => {
    if (!assets) return []
    const q = query.trim().toLowerCase()
    return assets
      .filter((a) => {
        if (effectiveProject === 'all') return true
        if (effectiveProject === 'none') return a.projectId === null
        return a.projectId === effectiveProject
      })
      .filter((a) => {
        if (workflow === 'all') return true
        if (workflow === 'active') return a.workflowStatus !== 'archived'
        return a.workflowStatus === workflow
      })
      .filter((a) => origin === 'all' || a.origin === origin)
      .filter((a) => {
        const s = assetState(a)
        if (state === 'issues') return s === 'error' || s === 'missing'
        if (state === 'importing') return s === 'importing' || s === 'queued'
        return true
      })
      .filter(
        (a) =>
          !q ||
          a.fileName.toLowerCase().includes(q) ||
          (a.title ?? '').toLowerCase().includes(q) ||
          a.sourcePath.toLowerCase().includes(q)
      )
      .sort(SORTS[sort])
  }, [assets, query, effectiveProject, workflow, origin, state, sort])

  // Drop selections that are no longer visible.
  useEffect(() => {
    setChecked((current) => {
      const ids = new Set(visible.map((a) => a.id))
      const next = new Set([...current].filter((id) => ids.has(id)))
      return next.size === current.size ? current : next
    })
  }, [visible])

  function toggleCheck(id: string, shift: boolean) {
    setChecked((current) => {
      const next = new Set(current)
      if (shift && lastChecked.current) {
        const ids = visible.map((a) => a.id)
        const from = ids.indexOf(lastChecked.current)
        const to = ids.indexOf(id)
        if (from >= 0 && to >= 0) {
          for (const rangeId of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(rangeId)
          return next
        }
      }
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    lastChecked.current = id
  }

  async function importWith(mode: 'files' | 'folder') {
    setBusy(true)
    try {
      const result = await unwrap(api.media.importWithDialog(mode, importProjectId))
      if (!result.cancelled) {
        const notice = importNotice(result)
        if (notice) onNotice(notice)
      }
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  async function bulkWorkflow(status: WorkflowStatus) {
    try {
      const updated = await unwrap(api.media.setWorkflowStatus([...checked], status))
      onNotice({ tone: 'success', text: `${plural(updated.length, 'conteúdo marcado', 'conteúdos marcados')} como “${WORKFLOW_LABELS[status]}”.` })
      setChecked(new Set())
    } catch (e) {
      onError(e)
    }
  }

  async function bulkProject(projectId: string | null) {
    try {
      const updated = await unwrap(api.media.setProject([...checked], projectId))
      const name = projectId ? projectById.get(projectId)?.name : 'Sem projeto'
      onNotice({ tone: 'success', text: `${plural(updated.length, 'conteúdo movido', 'conteúdos movidos')} para “${name}”.` })
      setChecked(new Set())
    } catch (e) {
      onError(e)
    }
  }

  async function relinkFolder() {
    try {
      const result = await unwrap(api.media.relinkFolder())
      if (result.cancelled) return
      onNotice(
        result.relinked
          ? {
              tone: 'success',
              text: `${plural(result.relinked, 'arquivo ausente encontrado', 'arquivos ausentes encontrados')}.${
                result.stillMissing ? ` ${result.stillMissing} ainda ausente(s).` : ''
              }`
            }
          : { tone: 'info', text: `Nenhum arquivo ausente estava nessa pasta (${result.scannedFiles} vídeos verificados).` }
      )
    } catch (e) {
      onError(e)
    }
  }

  const importTarget = importProjectId ? projectById.get(importProjectId)?.name : null

  return (
    <div className={`library${selected ? ' has-detail' : ''}`}>
      <div className="library-main">
        <header className="screen-header library-header">
          <div>
            <p className="eyebrow">Conteúdo</p>
            <h1>Biblioteca</h1>
          </div>
          <div className="row">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => importWith('folder')}
              disabled={!toolsReady || busy}
              data-testid="import-folder"
            >
              Importar pasta…
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => importWith('files')}
              disabled={!toolsReady || busy}
              data-testid="import-files"
              title={importTarget ? `Os vídeos entram no projeto ${importTarget}` : 'Os vídeos entram sem projeto'}
            >
              {importTarget ? `Importar vídeos para ${importTarget}…` : 'Importar vídeos…'}
            </button>
          </div>
        </header>

        <ToolsBanner tools={tools} onRecheck={library.recheckTools} onError={onError} />
        <ImportProgress queue={queue} onCancelAll={() => api.media.cancelAll().then(() => undefined, onError)} />

        {missingCount > 0 && (
          <div className="banner banner-warn" role="status" data-testid="missing-banner">
            <span>
              {missingCount === 1 ? '1 arquivo não foi encontrado' : `${missingCount} arquivos não foram encontrados`}. Eles
              podem ter sido movidos, renomeados ou estar num disco desconectado.
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={relinkFolder}>
              Procurar numa pasta…
            </button>
          </div>
        )}

        <div className="toolbar" role="search">
          <input
            type="search"
            className="toolbar-search"
            placeholder="Buscar por título, nome ou pasta"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Buscar conteúdo"
          />
          <select
            value={effectiveProject}
            onChange={(e) => setProject(e.target.value)}
            aria-label="Filtrar por projeto"
            data-testid="filter-project"
          >
            <option value="all">Todos os projetos</option>
            <option value="none">Sem projeto</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value as WorkflowFilter)}
            aria-label="Filtrar por status"
            data-testid="filter-workflow"
          >
            <option value="active">Não arquivados</option>
            <option value="all">Todos os status</option>
            {WORKFLOW_STATUSES.map((s) => (
              <option key={s} value={s}>
                {WORKFLOW_LABELS[s]}
              </option>
            ))}
          </select>
          <select value={origin} onChange={(e) => setOrigin(e.target.value as OriginFilter)} aria-label="Filtrar por origem">
            <option value="all">Qualquer origem</option>
            {(Object.keys(ORIGIN_LABELS) as ContentOrigin[]).map((o) => (
              <option key={o} value={o}>
                {ORIGIN_LABELS[o]}
              </option>
            ))}
          </select>
          <select value={state} onChange={(e) => setState(e.target.value as StateFilter)} aria-label="Filtrar por arquivo">
            <option value="all">Qualquer arquivo</option>
            <option value="issues">Com problema</option>
            <option value="importing">Importando</option>
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Ordenar por">
            <option value="added">Mais recentes</option>
            <option value="name">Nome</option>
            <option value="duration">Mais longos</option>
          </select>
        </div>

        {checked.size > 0 && (
          <div className="bulk-bar" role="region" aria-label="Ações em lote" data-testid="bulk-bar">
            <strong>{plural(checked.size, 'selecionado', 'selecionados')}</strong>
            <select
              value=""
              onChange={(e) => e.target.value && bulkWorkflow(e.target.value as WorkflowStatus)}
              aria-label="Mudar status dos selecionados"
              data-testid="bulk-workflow"
            >
              <option value="">Mudar status…</option>
              {WORKFLOW_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {WORKFLOW_LABELS[s]}
                </option>
              ))}
            </select>
            <ProjectSelect
              projects={projects}
              value={null}
              onChange={(id) => bulkProject(id)}
              label="Mover selecionados para projeto"
              noneLabel="Mover para…"
              testId="bulk-project"
            />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => bulkProject(null)}>
              Tirar do projeto
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setChecked(new Set(visible.map((a) => a.id)))}>
              Selecionar todos visíveis
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setChecked(new Set())}>
              Limpar
            </button>
          </div>
        )}

        {assets === null && !library.loadError && <p className="muted">Carregando…</p>}
        {library.loadError && (
          <p className="form-error" role="alert">
            Não foi possível carregar a biblioteca: {library.loadError}
          </p>
        )}

        {assets && assets.length === 0 && (
          <div className="empty-library" data-testid="library-empty">
            <p className="lead">Seus vídeos ficam aqui.</p>
            <p className="muted">
              Importe clipes manualmente ou configure a pasta de saída da Drop Machine em Configurações para que os novos
              clipes apareçam sozinhos. Os arquivos continuam onde estão: a biblioteca guarda só uma referência, os dados
              técnicos e uma miniatura.
            </p>
            <p className="muted small">
              Você também pode arrastar vídeos ou pastas para esta janela. Formatos: MP4, MOV, MKV, WebM, AVI e outros.
            </p>
          </div>
        )}

        {assets && assets.length > 0 && visible.length === 0 && <p className="muted">Nada corresponde a esses filtros.</p>}

        {visible.length > 0 && (
          <>
            <p className="muted small result-count">
              {visible.length === assets?.length
                ? plural(visible.length, 'conteúdo', 'conteúdos')
                : `${visible.length} de ${assets?.length} conteúdos`}
            </p>
            <ul className="asset-grid" data-testid="asset-grid">
              {visible.map((asset) => (
                <li key={asset.id}>
                  <AssetCard
                    asset={asset}
                    project={asset.projectId ? (projectById.get(asset.projectId) ?? null) : null}
                    selected={asset.id === selectedId}
                    checked={checked.has(asset.id)}
                    versionCount={versionCounts[asset.id] ?? 0}
                    onSelect={() => setSelectedId(asset.id)}
                    onToggleCheck={(shift) => toggleCheck(asset.id, shift)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {selected && (
        <AssetDetail
          key={selected.id}
          asset={selected}
          projects={projects}
          onOpenEditor={() => onOpenEditor(selected.id)}
          onOpenAccounts={onOpenAccounts}
          onOpenAnalytics={onOpenAnalytics}
          onClose={() => setSelectedId(null)}
          onNotice={onNotice}
          onError={(e) => onNotice({ tone: 'error', text: errorMessage(e) })}
        />
      )}
    </div>
  )
}

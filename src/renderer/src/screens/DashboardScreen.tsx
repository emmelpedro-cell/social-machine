import { useMemo, useState } from 'react'
import { EDITORIAL_LABELS, editorialState, WORKFLOW_LABELS, type ContentItem, type EditorialState } from '../../../shared/media'
import type { Project } from '../../../shared/schemas'
import type { WatchFolderStatus } from '../../../shared/watch'
import { WATCH_STATE_LABEL } from '../components/WatchFoldersPanel'
import { formatRelative, plural } from '../format'
import { assetState, displayName, thumbnailUrl } from '../media/format'
import type { LibraryFilters } from './LibraryScreen'
import type { NoticeState } from '../components/Notice'
import { PublicationsList } from '../publishing/PublicationsList'
import { usePublications } from '../publishing/usePublishing'
import { needsAttention, useQueue } from '../queue/useQueue'

type Props = {
  projects: Project[] | null
  assets: ContentItem[] | null
  folders: WatchFolderStatus[] | null
  toolsOk: boolean | null
  onOpenLibrary: (filters: LibraryFilters) => void
  onOpenProjects: () => void
  onOpenSettings: () => void
  onOpenQueue: () => void
  onNotice: (n: NoticeState) => void
  onError: (e: unknown) => void
}

export function DashboardScreen({ projects, assets, folders, toolsOk, onOpenLibrary, onOpenProjects, onOpenSettings, onOpenQueue, onNotice, onError }: Props) {
  const { publications } = usePublications(undefined, 5)
  const [queueRange] = useState(() => ({ from: new Date(), to: new Date(Date.now() + 14 * 86_400_000) }))
  const { items: queue } = useQueue(queueRange.from, queueRange.to)
  const attention = (queue ?? []).filter(needsAttention).length
  const upcoming = useMemo(
    () =>
      (queue ?? [])
        .filter((p) => p.status === 'scheduled' && !p.fields.missed && p.scheduledAt)
        .sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))
        .slice(0, 5),
    [queue]
  )
  const stats = useMemo(() => {
    const byWorkflow: Record<EditorialState, number> = { imported: 0, needs_review: 0, editing: 0, ready: 0, archived: 0, published: 0 }
    let withoutProject = 0
    let issues = 0
    for (const a of assets ?? []) {
      byWorkflow[editorialState(a)]++
      if (!a.projectId && a.workflowStatus !== 'archived') withoutProject++
      const s = assetState(a)
      if (s === 'error' || s === 'missing') issues++
    }
    return { byWorkflow, withoutProject, issues }
  }, [assets])

  const recent = useMemo(
    () => [...(assets ?? [])].sort((a, b) => b.importedAt.localeCompare(a.importedAt)).slice(0, 8),
    [assets]
  )
  const projectById = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p])), [projects])

  const tiles: { label: string; value: number; filters: LibraryFilters; tone?: string; testId: string }[] = [
    { label: WORKFLOW_LABELS.needs_review, value: stats.byWorkflow.needs_review, filters: { project: 'all', workflow: 'needs_review' }, tone: 'review', testId: 'tile-review' },
    { label: WORKFLOW_LABELS.editing, value: stats.byWorkflow.editing, filters: { project: 'all', workflow: 'editing' }, testId: 'tile-editing' },
    { label: 'Prontos para publicar', value: stats.byWorkflow.ready, filters: { project: 'all', workflow: 'ready' }, tone: 'ready', testId: 'tile-ready' },
    { label: 'Publicados', value: stats.byWorkflow.published, filters: { project: 'all', workflow: 'published' }, tone: 'published', testId: 'tile-published' },
    { label: 'Sem projeto', value: stats.withoutProject, filters: { project: 'none', workflow: 'active' }, testId: 'tile-unassigned' }
  ]

  return (
    <div className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Social Machine</p>
          <h1>Dashboard</h1>
        </div>
      </header>

      {toolsOk === false && (
        <div className="banner banner-error" role="alert">
          <span>O FFmpeg não está funcionando, então nenhum vídeo pode ser importado agora.</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenLibrary({ project: 'all', workflow: 'active' })}>
            Ver detalhes
          </button>
        </div>
      )}

      <section className="tiles" aria-label="Resumo da biblioteca">
        {tiles.map((t) => (
          <button
            key={t.testId}
            type="button"
            className={`tile${t.tone ? ` tile-${t.tone}` : ''}`}
            onClick={() => onOpenLibrary(t.filters)}
            data-testid={t.testId}
          >
            <span className="tile-value">{assets ? t.value : '–'}</span>
            <span className="tile-label">{t.label}</span>
          </button>
        ))}
        {stats.issues > 0 && (
          <div className="tile tile-warn" data-testid="tile-issues">
            <span className="tile-value">{stats.issues}</span>
            <span className="tile-label">com problema no arquivo</span>
          </div>
        )}
      </section>

      <div className="dash-grid">
        <section className="panel">
          <div className="panel-head">
            <h2>Importados recentemente</h2>
            <button type="button" className="link-btn" onClick={() => onOpenLibrary({ project: 'all', workflow: 'active' })}>
              Abrir biblioteca
            </button>
          </div>
          {assets && assets.length === 0 && (
            <p className="muted">Nenhum vídeo ainda. Configure a pasta da Drop Machine ou importe vídeos pela Biblioteca.</p>
          )}
          {recent.length > 0 && (
            <ul className="recent-list" data-testid="recent-list">
              {recent.map((a) => {
                const project = a.projectId ? projectById.get(a.projectId) : undefined
                return (
                  <li key={a.id} className="recent-item">
                    <span className="recent-thumb">
                      {a.hasThumbnail ? <img src={thumbnailUrl(a)} alt="" loading="lazy" /> : null}
                    </span>
                    <span className="recent-text">
                      <span className="recent-name">{displayName(a)}</span>
                      <span className="small muted">
                        <span className="project-dot" style={{ background: project?.color ?? 'var(--text-faint)' }} aria-hidden="true" />
                        {project?.name ?? 'Sem projeto'} · {EDITORIAL_LABELS[editorialState(a)]} · {formatRelative(a.importedAt)}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <div className="dash-side">
          <section className="panel">
            <div className="panel-head">
              <h2>Pastas monitoradas</h2>
              <button type="button" className="link-btn" onClick={onOpenSettings}>
                Configurar
              </button>
            </div>
            {folders && folders.length === 0 && (
              <div>
                <p className="muted small">Nenhuma pasta configurada. Aponte para a saída da Drop Machine e os clipes novos chegam sozinhos.</p>
                <button type="button" className="btn btn-primary btn-sm" onClick={onOpenSettings} data-testid="dash-setup-watch">
                  Configurar pasta da Drop Machine
                </button>
              </div>
            )}
            {folders && folders.length > 0 && (
              <ul className="watch-summary" data-testid="dash-watch">
                {folders.map((f) => (
                  <li key={f.id}>
                    <span className={`watch-dot dot-${f.state}`} aria-hidden="true" />
                    <span className="watch-summary-text">
                      <span className="small">{f.origin === 'drop_machine' ? 'Drop Machine' : (f.label ?? f.path.split(/[\\/]/).pop())}</span>
                      <span className="small muted">
                        {WATCH_STATE_LABEL[f.state]}
                        {f.waitingFiles > 0 ? ` · ${f.waitingFiles} aguardando` : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Projetos</h2>
              <button type="button" className="link-btn" onClick={onOpenProjects}>
                Gerenciar
              </button>
            </div>
            {projects && projects.length === 0 && <p className="muted small">Nenhum projeto ainda.</p>}
            {projects && projects.length > 0 && (
              <ul className="project-summary">
                {projects.map((p) => {
                  const count = assets?.filter((a) => a.projectId === p.id).length ?? 0
                  return (
                    <li key={p.id}>
                      <button type="button" className="project-summary-row" onClick={() => onOpenLibrary({ project: p.id, workflow: 'active' })}>
                        <span className="project-dot" style={{ background: p.color }} aria-hidden="true" />
                        <span>{p.name}</span>
                        <span className="muted small">{plural(count, 'conteúdo', 'conteúdos')}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Próximas publicações</h2>
              <button type="button" className="link-btn" onClick={onOpenQueue}>
                Abrir fila
              </button>
            </div>
            {attention > 0 && (
              <p className="small hint" data-testid="dash-pub-attention">
                {attention} publicação(ões) precisam de você (falharam, aguardam você publicar, perderam o horário ou estão pausadas).{' '}
                <button type="button" className="link-btn" onClick={onOpenQueue}>
                  Ver
                </button>
              </p>
            )}
            <div data-testid="dash-upcoming">
              {queue && upcoming.length === 0 ? (
                <p className="muted small">Nada agendado para os próximos 14 dias.</p>
              ) : (
                <PublicationsList publications={queue ? upcoming : null} showContent onNotice={onNotice} onError={onError} />
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Atividade recente</h2>
            </div>
            <div data-testid="dash-publications">
              <PublicationsList publications={publications} showContent onNotice={onNotice} onError={onError} />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

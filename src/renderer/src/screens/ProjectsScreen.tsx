import { useMemo, useState } from 'react'
import type { ContentItem } from '../../../shared/media'
import type { Project } from '../../../shared/schemas'
import type { WatchFolderStatus } from '../../../shared/watch'
import { api, unwrap } from '../api'
import type { NoticeState } from '../components/Notice'
import { plural } from '../format'

type Props = {
  projects: Project[] | null
  assets: ContentItem[] | null
  folders: WatchFolderStatus[] | null
  onNewProject: () => void
  onEditProject: (project: Project) => void
  onOpenLibrary: (projectId: string) => void
  onChanged: () => Promise<void>
  onNotice: (n: NoticeState) => void
  onError: (e: unknown) => void
}

export function ProjectsScreen({
  projects,
  assets,
  folders,
  onNewProject,
  onEditProject,
  onOpenLibrary,
  onChanged,
  onNotice,
  onError
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const counts = useMemo(() => {
    const map = new Map<string, { total: number; review: number; ready: number }>()
    for (const a of assets ?? []) {
      if (!a.projectId) continue
      const c = map.get(a.projectId) ?? { total: 0, review: 0, ready: 0 }
      c.total++
      if (a.workflowStatus === 'needs_review') c.review++
      if (a.workflowStatus === 'ready') c.ready++
      map.set(a.projectId, c)
    }
    return map
  }, [assets])

  async function createSuggested() {
    try {
      const created = await unwrap(api.projects.createSuggested())
      await onChanged()
      onNotice({ tone: 'success', text: `${plural(created.length, 'projeto criado', 'projetos criados')}.` })
    } catch (e) {
      onError(e)
    }
  }

  async function remove(project: Project) {
    try {
      await unwrap(api.projects.delete(project.id))
      setConfirmDelete(null)
      await onChanged()
      onNotice({ tone: 'info', text: `Projeto “${project.name}” excluído. Os conteúdos dele continuam na biblioteca, sem projeto.` })
    } catch (e) {
      onError(e)
    }
  }

  return (
    <div className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Organização</p>
          <h1>Projetos</h1>
        </div>
        <button type="button" className="btn btn-primary btn-lg" onClick={onNewProject} data-testid="new-project">
          Novo projeto
        </button>
      </header>

      {projects === null && <p className="muted">Carregando…</p>}

      {projects && projects.length === 0 && (
        <section className="panel empty" data-testid="projects-empty">
          <p className="lead">Nenhum projeto ainda.</p>
          <p className="muted">
            Crie um projeto por nicho. Cada um terá seus conteúdos, contas, hashtags e preferências de publicação.
          </p>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={createSuggested} data-testid="create-suggested">
              Criar MMA, Futebol, Basquete e Skate
            </button>
            <button type="button" className="btn btn-ghost" onClick={onNewProject}>
              Criar outro…
            </button>
          </div>
        </section>
      )}

      {projects && projects.length > 0 && (
        <ul className="project-list" data-testid="project-list">
          {projects.map((p) => {
            const c = counts.get(p.id) ?? { total: 0, review: 0, ready: 0 }
            const watched = folders?.filter((f) => f.projectId === p.id).length ?? 0
            return (
              <li key={p.id} className="project-item" data-testid="project-item" data-name={p.name}>
                <span className="project-swatch" style={{ background: p.color }} aria-hidden="true" />
                <div className="project-item-main">
                  <h2>{p.name}</h2>
                  <p className="muted small">
                    {[p.category, p.description].filter(Boolean).join(' · ') || 'Sem descrição'}
                  </p>
                  <p className="project-item-stats">
                    <span data-testid="project-count">{plural(c.total, 'conteúdo', 'conteúdos')}</span>
                    {c.review > 0 && <span className="tag tag-review">{c.review} para revisar</span>}
                    {c.ready > 0 && <span className="tag tag-done">{c.ready} prontos</span>}
                    {watched > 0 && <span className="muted">{plural(watched, 'pasta monitorada', 'pastas monitoradas')}</span>}
                    <span className="muted">Contas: Fase 3</span>
                  </p>
                </div>
                <div className="project-item-actions">
                  {confirmDelete === p.id ? (
                    <div className="confirm inline">
                      <p>Excluir “{p.name}”? Os conteúdos ficam na biblioteca, sem projeto.</p>
                      <div className="row">
                        <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(p)}>
                          Excluir
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(null)}>
                          Manter
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenLibrary(p.id)}>
                        Ver conteúdos
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onEditProject(p)}>
                        Editar
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm btn-danger-text" onClick={() => setConfirmDelete(p.id)}>
                        Excluir…
                      </button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

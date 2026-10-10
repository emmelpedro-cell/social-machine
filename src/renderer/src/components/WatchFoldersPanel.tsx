import { useState } from 'react'
import type { Project } from '../../../shared/schemas'
import { DROP_MACHINE_DEFAULT_OUTPUT, type WatchFolderStatus, type WatchOrigin, type WatchState } from '../../../shared/watch'
import { api, unwrap } from '../api'
import { formatRelative, plural } from '../format'
import type { NoticeState } from './Notice'
import { ProjectSelect } from './ProjectSelect'

export const WATCH_STATE_LABEL: Record<WatchState, string> = {
  watching: 'Monitorando',
  polling: 'Verificação periódica',
  unavailable: 'Pasta indisponível',
  disabled: 'Pausada'
}

const WATCH_STATE_HINT: Record<WatchState, string> = {
  watching: 'Novos arquivos são detectados na hora, com varredura periódica de segurança.',
  polling: 'O sistema não entrega eventos desta pasta; novos arquivos são encontrados na varredura periódica.',
  unavailable: 'A pasta não existe ou não pode ser lida agora. Ela é verificada de novo automaticamente.',
  disabled: 'O monitoramento desta pasta está pausado.'
}

type Props = {
  folders: WatchFolderStatus[] | null
  projects: Project[]
  toolsReady: boolean
  onNotice: (n: NoticeState) => void
  onError: (e: unknown) => void
}

export function WatchFoldersPanel({ folders, projects, toolsReady, onNotice, onError }: Props) {
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const hasDropMachine = folders?.some((f) => f.origin === 'drop_machine') ?? false

  async function add(origin: WatchOrigin) {
    try {
      const result = await unwrap(api.watch.add(origin))
      if (!result.cancelled) {
        onNotice({ tone: 'success', text: `Monitorando “${result.folder.path}”. Vídeos já existentes nela estão sendo importados.` })
      }
    } catch (e) {
      onError(e)
    }
  }

  const update = (id: string, patch: { projectId?: string | null; origin?: WatchOrigin; enabled?: boolean }) =>
    unwrap(api.watch.update({ id, ...patch })).then(() => undefined, onError)

  async function scanNow() {
    setScanning(true)
    try {
      await unwrap(api.watch.scanNow())
      onNotice({ tone: 'info', text: 'Pastas verificadas.' })
    } catch (e) {
      onError(e)
    } finally {
      setScanning(false)
    }
  }

  async function remove(folder: WatchFolderStatus) {
    try {
      await unwrap(api.watch.remove(folder.id))
      setConfirmRemove(null)
      onNotice({ tone: 'info', text: 'A pasta não é mais monitorada. Os vídeos já importados continuam na biblioteca.' })
    } catch (e) {
      onError(e)
    }
  }

  return (
    <section className="panel" data-testid="watch-panel">
      <div className="panel-head">
        <h2>Pastas monitoradas</h2>
        {folders && folders.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={scanNow} disabled={scanning}>
            {scanning ? 'Verificando…' : 'Verificar agora'}
          </button>
        )}
      </div>
      <p className="muted small">
        Vídeos novos nessas pastas entram sozinhos na biblioteca como “Precisa de revisão”, depois que terminam de ser
        gravados. Nada nas pastas é movido, renomeado ou apagado.
      </p>
      {!toolsReady && (
        <p className="hint">Enquanto o FFmpeg estiver indisponível, os arquivos novos esperam e são importados depois.</p>
      )}

      {folders === null && <p className="muted">Carregando…</p>}

      {folders && folders.length > 0 && (
        <ul className="watch-list" data-testid="watch-list">
          {folders.map((f) => (
            <li key={f.id} className={`watch-item state-${f.state}`} data-testid="watch-item" data-path={f.path}>
              <div className="watch-item-head">
                <span className={`watch-dot dot-${f.state}`} aria-hidden="true" />
                <div className="watch-item-title">
                  <code className="path">{f.path}</code>
                  <p className="small muted" title={WATCH_STATE_HINT[f.state]}>
                    <span data-testid="watch-state">{WATCH_STATE_LABEL[f.state]}</span>
                    {f.waitingFiles > 0 && ` · ${plural(f.waitingFiles, 'arquivo terminando de gravar', 'arquivos terminando de gravar')}`}
                    {f.lastScanAt && ` · última verificação ${formatRelative(f.lastScanAt)}`}
                  </p>
                  {f.lastError && f.state !== 'disabled' && <p className="small form-error">{f.lastError}</p>}
                </div>
              </div>
              <div className="watch-item-controls">
                <label className="inline-field">
                  <span>Origem</span>
                  <select
                    value={f.origin}
                    onChange={(e) => update(f.id, { origin: e.target.value as WatchOrigin })}
                    aria-label="Origem dos vídeos"
                  >
                    <option value="drop_machine">Drop Machine</option>
                    <option value="watch_folder">Outra pasta</option>
                  </select>
                </label>
                <label className="inline-field">
                  <span>Projeto</span>
                  <ProjectSelect
                    projects={projects}
                    value={f.projectId}
                    onChange={(projectId) => update(f.id, { projectId })}
                    label="Projeto dos novos vídeos"
                    noneLabel="Sem projeto (triagem)"
                    testId="watch-project"
                  />
                </label>
                <label className="toggle">
                  <input type="checkbox" checked={f.enabled} onChange={(e) => update(f.id, { enabled: e.target.checked })} />
                  <span>Ativa</span>
                </label>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => api.watch.openFolder(f.id).then(() => undefined, onError)}>
                  Abrir
                </button>
                {confirmRemove === f.id ? (
                  <>
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(f)}>
                      Parar de monitorar
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmRemove(null)}>
                      Cancelar
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm btn-danger-text" onClick={() => setConfirmRemove(f.id)}>
                    Remover…
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="row wrap">
        {!hasDropMachine && (
          <button type="button" className="btn btn-primary" onClick={() => add('drop_machine')} data-testid="add-drop-machine">
            Adicionar pasta da Drop Machine…
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={() => add('watch_folder')} data-testid="add-watch-folder">
          Adicionar outra pasta…
        </button>
      </div>
      {!hasDropMachine && (
        <p className="muted small">
          Normalmente a saída da Drop Machine fica em <code className="path">{DROP_MACHINE_DEFAULT_OUTPUT}</code>.
        </p>
      )}
    </section>
  )
}

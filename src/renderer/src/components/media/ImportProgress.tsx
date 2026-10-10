import type { ImportQueueState } from '../../../../shared/media'

export function ImportProgress({ queue, onCancelAll }: { queue: ImportQueueState; onCancelAll: () => void }) {
  if (!queue.active) return null
  const done = Math.min(queue.completed, queue.total)
  const percent = queue.total ? Math.round((done / queue.total) * 100) : 0
  return (
    <div className="import-progress" role="status" aria-live="polite" data-testid="import-progress">
      <div className="import-progress-text">
        <strong>
          Importando {done} de {queue.total}
        </strong>
        {queue.current.length > 0 && <span className="muted"> · {queue.current.join(', ')}</span>}
        {queue.failed > 0 && <span className="import-failed"> · {queue.failed} com falha</span>}
      </div>
      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onCancelAll}>
        Cancelar
      </button>
    </div>
  )
}

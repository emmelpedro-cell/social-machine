import type { Account } from '../../../shared/publishing'
import type { Project } from '../../../shared/schemas'
import type { QueueFilter } from './useQueue'

type Props = { filter: QueueFilter; onChange: (f: QueueFilter) => void; projects: Project[]; accounts: Account[] | null }

export function QueueFilters({ filter, onChange, projects, accounts }: Props) {
  return (
    <div className="row wrap">
      <select value={filter.project} onChange={(e) => onChange({ ...filter, project: e.target.value })} aria-label="Projeto" data-testid="queue-filter-project">
        <option value="all">Todos os projetos</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        <option value="none">Sem projeto</option>
      </select>
      <select value={filter.account} onChange={(e) => onChange({ ...filter, account: e.target.value })} aria-label="Conta" data-testid="queue-filter-account">
        <option value="all">Todas as contas</option>
        {(accounts ?? []).map((a) => (
          <option key={a.id} value={a.id}>
            {a.displayName}
          </option>
        ))}
      </select>
    </div>
  )
}

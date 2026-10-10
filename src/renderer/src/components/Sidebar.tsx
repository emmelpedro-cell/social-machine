export type ScreenId =
  | 'dashboard'
  | 'library'
  | 'projects'
  | 'editor'
  | 'queue'
  | 'calendar'
  | 'inbox'
  | 'analytics'
  | 'accounts'
  | 'settings'

type Item = { id: ScreenId; label: string; phase?: number; badge?: number }

type Props = {
  current: ScreenId
  onNavigate: (id: ScreenId) => void
  version?: string
  needsReview: number
}

export function Sidebar({ current, onNavigate, version, needsReview }: Props) {
  const main: Item[] = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'library', label: 'Biblioteca', badge: needsReview },
    { id: 'projects', label: 'Projetos' }
  ]
  const later: Item[] = [
    { id: 'editor', label: 'Editor', phase: 2 },
    { id: 'accounts', label: 'Contas', phase: 3 },
    { id: 'queue', label: 'Fila', phase: 4 },
    { id: 'calendar', label: 'Calendário', phase: 4 },
    { id: 'analytics', label: 'Analytics', phase: 5 },
    { id: 'inbox', label: 'Inbox', phase: 6 }
  ]

  const renderItem = (item: Item) => (
    <li key={item.id}>
      <button
        type="button"
        className={`nav-item${current === item.id ? ' is-active' : ''}${item.phase ? ' is-later' : ''}`}
        aria-current={current === item.id ? 'page' : undefined}
        onClick={() => onNavigate(item.id)}
      >
        <span>{item.label}</span>
        {item.phase !== undefined && (
          <span className="nav-phase" title={`Chega na Fase ${item.phase}`}>
            F{item.phase}
          </span>
        )}
        {!item.phase && item.badge ? (
          <span className="nav-badge" title={`${item.badge} para revisar`} data-testid={`nav-badge-${item.id}`}>
            {item.badge}
          </span>
        ) : null}
      </button>
    </li>
  )

  return (
    <nav className="sidebar" aria-label="Navegação principal">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="brand-name">
          Social
          <br />
          Machine
        </span>
      </div>

      <ul className="nav">{main.map(renderItem)}</ul>
      <p className="nav-section">Próximas fases</p>
      <ul className="nav">{later.map(renderItem)}</ul>

      <div className="sidebar-footer">
        <button
          type="button"
          className={`nav-item${current === 'settings' ? ' is-active' : ''}`}
          aria-current={current === 'settings' ? 'page' : undefined}
          onClick={() => onNavigate('settings')}
        >
          Configurações
        </button>
        <p className="build-tag">Fase 1 · base{version ? ` · v${version}` : ''}</p>
      </div>
    </nav>
  )
}

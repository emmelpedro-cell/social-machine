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
  /** Publications waiting for the user (manual, failed, missed, paused). */
  attention: number
  /** Unread comments in the Inbox. */
  inboxUnread: number
}

export function Sidebar({ current, onNavigate, version, needsReview, attention, inboxUnread }: Props) {
  const main: Item[] = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'library', label: 'Biblioteca', badge: needsReview },
    { id: 'editor', label: 'Editor' },
    { id: 'queue', label: 'Fila', badge: attention },
    { id: 'calendar', label: 'Calendário' },
    { id: 'inbox', label: 'Inbox', badge: inboxUnread },
    { id: 'analytics', label: 'Analytics' },
    { id: 'projects', label: 'Projetos' },
    { id: 'accounts', label: 'Contas' }
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
          <span className="nav-badge" title={item.id === 'queue' ? `${item.badge} precisam de você` : item.id === 'inbox' ? `${item.badge} não lidos` : `${item.badge} para revisar`} data-testid={`nav-badge-${item.id}`}>
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

      <div className="sidebar-footer">
        <button
          type="button"
          className={`nav-item${current === 'settings' ? ' is-active' : ''}`}
          aria-current={current === 'settings' ? 'page' : undefined}
          onClick={() => onNavigate('settings')}
        >
          Configurações
        </button>
        <p className="build-tag">Fase 6 · inbox{version ? ` · v${version}` : ''}</p>
      </div>
    </nav>
  )
}

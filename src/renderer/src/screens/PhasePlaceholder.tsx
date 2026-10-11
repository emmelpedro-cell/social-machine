type PlaceholderProps = {
  title: string
  phase: number
  summary: string
  planned: string[]
}

/**
 * Deliberately non-interactive: unfinished areas say what they will do and
 * when, instead of showing controls that don't work.
 */
export function PhasePlaceholder({ title, phase, summary, planned }: PlaceholderProps) {
  return (
    <div className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Ainda não disponível</p>
          <h1>{title}</h1>
        </div>
        <span className="tag tag-pending tag-lg">Chega na Fase {phase}</span>
      </header>
      <section className="panel placeholder">
        <p className="lead">{summary}</p>
        <h2 className="small-heading">Planejado</h2>
        <ul className="planned">
          {planned.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
    </div>
  )
}

export type PlaceholderId = 'inbox'

export const PLACEHOLDERS: Record<PlaceholderId, PlaceholderProps> = {
  inbox: {
    title: 'Inbox',
    phase: 6,
    summary: 'Comentários e notificações das contas conectadas num só lugar, conforme o que cada API permite.',
    planned: [
      'Filtros por projeto, plataforma, conta e conteúdo',
      'Marcar como lido ou resolvido',
      'Responder quando a plataforma autoriza',
      'Sugestões de resposta por IA sempre revisadas por você'
    ]
  }
}

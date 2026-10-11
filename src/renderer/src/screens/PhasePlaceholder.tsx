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

export type PlaceholderId = 'queue' | 'calendar' | 'inbox' | 'analytics'

export const PLACEHOLDERS: Record<PlaceholderId, PlaceholderProps> = {
  queue: {
    title: 'Fila de publicação',
    phase: 4,
    summary: 'Publicações preparadas, por conta e por destino, com agendamento local.',
    planned: [
      'Uma tarefa independente por destino: uma falha não bloqueia as outras',
      'Dias e horários preferenciais por conta',
      'Reagendar, pausar e cancelar',
      'Proteção contra publicar a mesma tarefa duas vezes'
    ]
  },
  calendar: {
    title: 'Calendário',
    phase: 4,
    summary: 'Visão diária, semanal e mensal de tudo o que está agendado ou publicado.',
    planned: ['Conteúdo, projeto, conta, plataforma, horário e status de cada publicação', 'Edição de horário por destino']
  },
  analytics: {
    title: 'Analytics',
    phase: 5,
    summary: 'Comparar desempenho por conteúdo, projeto e rede, apenas com dados reais das APIs.',
    planned: [
      'Histórico de métricas ao longo do tempo',
      'Comparação do mesmo conteúdo entre plataformas',
      'Dados indisponíveis indicados como indisponíveis, nunca como zero'
    ]
  },
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

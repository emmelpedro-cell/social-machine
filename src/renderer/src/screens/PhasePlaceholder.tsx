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

export type PlaceholderId = 'editor' | 'queue' | 'calendar' | 'inbox' | 'analytics' | 'accounts'

export const PLACEHOLDERS: Record<PlaceholderId, PlaceholderProps> = {
  editor: {
    title: 'Editor',
    phase: 2,
    summary: 'Preparar clipes para publicação sem abrir outro editor. O arquivo original nunca é sobrescrito.',
    planned: [
      'Corte do início e do fim, controle de duração',
      'Recorte, zoom e reenquadramento para 9:16',
      'Texto sobre o vídeo com fontes, cor, contorno e sombra',
      'Presets por projeto e prévia das áreas cobertas pela interface das plataformas',
      'Várias versões do mesmo conteúdo, exportadas com FFmpeg'
    ]
  },
  accounts: {
    title: 'Contas',
    phase: 3,
    summary: 'Conectar contas do YouTube, TikTok e Instagram pelas APIs oficiais (OAuth). Senhas nunca são guardadas.',
    planned: [
      'Adicionar, reconectar e desconectar contas',
      'Associar contas a um ou mais projetos',
      'Mostrar o que cada conta realmente permite (publicar, métricas, comentários)',
      'Tokens guardados no cofre protegido do Windows, nunca no banco nem nos logs'
    ]
  },
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

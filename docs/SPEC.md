SOCIAL MACHINE — PLANO MESTRE DO PROJETO

1. Visão geral

Desenvolver um aplicativo desktop/local chamado Social Machine, que funcione como uma central de gerenciamento, edição, distribuição e análise de conteúdo para múltiplas redes sociais e múltiplas contas.

O aplicativo deve permitir que o usuário gerencie todo o fluxo de produção e distribuição de vídeos em um só lugar, sem precisar navegar constantemente entre TikTok, YouTube e outras plataformas.

A Social Machine deve funcionar em conjunto com um aplicativo existente chamado Drop Machine, que identifica momentos interessantes em vídeos longos e gera clipes curtos automaticamente.

A proposta é transformar as duas ferramentas em um ecossistema:

* Drop Machine: encontra momentos interessantes e gera clipes.
* Social Machine: organiza, edita, agenda, publica e analisa os conteúdos gerados.

O sistema deve ser modular, permitindo adicionar novas redes sociais e funcionalidades sem precisar reconstruir a aplicação.

Objetivos principais

1. Gerenciar múltiplos projetos de conteúdo.
2. Conectar diversas contas de redes sociais.
3. Importar automaticamente os vídeos gerados pela Drop Machine.
4. Editar e preparar vídeos para publicação.
5. Criar diferentes versões de um mesmo conteúdo.
6. Distribuir conteúdos para várias contas e plataformas.
7. Organizar publicações em filas e calendários.
8. Reunir notificações e comentários em uma caixa de entrada unificada.
9. Comparar o desempenho de diferentes redes sociais.
10. Aprender, a partir dos dados, quais conteúdos e estratégias funcionam melhor.
11. Manter uma experiência de uso independente das interfaces das redes sociais.

⸻

2. Arquitetura tecnológica proposta

A aplicação deve ser desenvolvida prioritariamente para Windows, com funcionamento local.

Stack sugerida

* Frontend: React + TypeScript.
* Interface desktop: Electron ou Tauri. Avaliar a melhor opção antes de implementar.
* Backend local: Node.js + TypeScript.
* Banco de dados: SQLite.
* Processamento de vídeo: FFmpeg.
* Renderização de interfaces e vídeos: reutilizar tecnologias da Drop Machine quando apropriado.
* Autenticação de plataformas: OAuth oficial.
* Integrações: APIs oficiais de cada rede social.
* Comunicação interna: API local entre frontend e backend.
* Armazenamento: arquivos locais, com metadados no SQLite.

A arquitetura precisa separar a interface visual, o processamento de vídeo, o banco de dados e os conectores das plataformas.

Princípios

* Priorizar funcionamento local.
* Não depender de uma assinatura de serviço externo para as funcionalidades básicas locais.
* Não exigir que todas as redes estejam conectadas.
* Permitir que cada integração seja desenvolvida e ativada independentemente.
* Não armazenar senhas de redes sociais diretamente.
* Proteger tokens de acesso e permitir desconectar contas.
* Não apagar os arquivos originais durante a edição ou publicação.
* Registrar erros e permitir retomar tarefas interrompidas.
* Não presumir que todas as plataformas oferecem as mesmas funções.

⸻

3. Organização por projetos de conteúdo

O aplicativo deve organizar os conteúdos por projetos, e não apenas por contas individuais.

Inicialmente, o usuário pretende administrar cinco projetos:

1. MMA.
2. Futebol.
3. Basquete.
4. Skate.
5. Um quinto projeto a ser definido posteriormente.

Cada projeto deve ter suas próprias configurações, conteúdos, contas, identidade visual, hashtags, padrões de legenda e preferências de publicação.

Exemplo de estrutura

Social Machine
│
├── MMA
│   ├── Conteúdos
│   ├── Versões
│   ├── TikTok
│   ├── YouTube
│   ├── Fila de publicação
│   └── Analytics
│
├── Futebol
│   ├── Conteúdos
│   ├── Versões
│   ├── TikTok
│   ├── YouTube
│   ├── Fila de publicação
│   └── Analytics
│
├── Basquete
├── Skate
└── Projeto 5

O projeto não deve exigir que todas as contas estejam conectadas. Por exemplo, o usuário pode configurar o projeto MMA e conectar apenas o TikTok, deixando o YouTube para depois.

Configurações por projeto

* Nome e descrição.
* Categoria ou nicho.
* Contas associadas.
* Fontes de conteúdo.
* Tipografia padrão.
* Posição e estilo das legendas sobre o vídeo.
* Hashtags padrão.
* Modelos de descrição.
* Preferências de formato e duração.
* Preferências de publicação.
* Horários preferenciais.
* Estatísticas do projeto.
* Pasta local de armazenamento.

⸻

4. Gerenciamento de contas

Criar uma seção chamada Contas, na qual o usuário possa conectar, desconectar e gerenciar diferentes perfis.

A interface deve utilizar o botão “Adicionar conta”.

Exemplo

CONTAS
TikTok
├── MMA TikTok          Conectada
├── Futebol TikTok      Conectada
├── Basquete TikTok     Não conectado
├── Skate TikTok        Conectada
└── Projeto 5 TikTok    Não conectado
YouTube
├── MMA YouTube         Conectada
├── Futebol YouTube     Conectada
├── Basquete YouTube    Conectada
├── Skate YouTube       Não conectado
└── Projeto 5 YouTube   Não conectado

Esse exemplo é ilustrativo. O aplicativo deve permitir adicionar contas além dessas.

Requisitos

* Cada conta possui autenticação e tokens próprios.
* Uma conta conectada pode ser associada a um projeto.
* O usuário pode associar várias contas ao mesmo projeto.
* Uma mesma conta pode ser associada a mais de um projeto, caso faça sentido.
* O usuário pode selecionar várias contas como destinos de uma publicação.
* A interface deve indicar se uma conta está conectada, desconectada, com token expirado ou com algum erro.
* Deve ser possível reconectar uma conta sem perder o histórico de publicações.
* As funcionalidades disponíveis devem depender das permissões e capacidades reais da plataforma.

Integrações prioritárias

1. YouTube.
2. TikTok.
3. Instagram.
4. Outras redes futuramente, conforme APIs e permissões disponíveis.

Não implementar todas de uma vez. Criar uma arquitetura de conectores para facilitar a expansão.

⸻

5. Integração com a Drop Machine

A integração com a Drop Machine é uma das funcionalidades mais importantes.

A Drop Machine já possui um fluxo local de processamento de vídeos e geração de clipes. A Social Machine deve aproveitar esse trabalho em vez de duplicar suas funcionalidades.

Fluxo desejado

Vídeo longo ou compilação
          ↓
     Drop Machine
          ↓
Detecção de momentos interessantes
          ↓
Revisão e renderização dos clipes
          ↓
Pasta de saída /output
          ↓
     Social Machine
          ↓
Biblioteca de conteúdos
          ↓
Editor → Fila → Publicação → Analytics

Requisitos de integração

* Permitir selecionar a pasta de saída da Drop Machine.
* Monitorar a pasta configurada e detectar novos vídeos.
* Importar os vídeos sem movê-los ou apagá-los automaticamente.
* Registrar o caminho do arquivo, data de importação e origem.
* Evitar importar o mesmo arquivo repetidamente.
* Mostrar os novos clipes em uma seção de conteúdo pendente.
* Permitir enviar manualmente um clipe da Drop Machine para a Social Machine.
* Preparar uma integração futura mais direta entre as duas interfaces.

Importante

A Social Machine não deve depender exclusivamente da Drop Machine. O usuário também precisa poder importar vídeos manualmente, selecionar arquivos existentes e criar conteúdos do zero.

⸻

6. Biblioteca de conteúdos

Criar uma seção central chamada Conteúdo, funcionando como uma biblioteca de todos os vídeos.

Cada item deve mostrar:

* Miniatura.
* Nome do arquivo.
* Projeto associado.
* Duração.
* Resolução e proporção.
* Data de importação.
* Origem do arquivo.
* Status de edição.
* Status de publicação.
* Plataformas de destino.
* Data da última publicação.
* Indicadores básicos de desempenho, quando disponíveis.

Filtros

* Projeto.
* Plataforma.
* Status.
* Data de criação.
* Data de publicação.
* Origem.
* Conteúdos publicados ou não publicados.
* Conteúdos com erro.
* Conteúdos agendados.

Status sugeridos

* Importado.
* Precisa de revisão.
* Em edição.
* Pronto para publicar.
* Na fila.
* Agendado.
* Publicado.
* Falha na publicação.
* Arquivado.

Um mesmo conteúdo pode ter status diferentes em diferentes destinos. Por exemplo, publicado no TikTok, mas aguardando publicação no YouTube.

⸻

7. Editor de vídeo integrado

Desenvolver um editor leve, voltado principalmente à preparação de vídeos curtos para redes sociais.

O objetivo não é substituir um editor profissional completo, mas oferecer as ferramentas necessárias para preparar clipes rapidamente.

Funcionalidades da primeira versão

1. Visualização do vídeo.
2. Corte do início e do final.
3. Controle de duração.
4. Recorte e reenquadramento.
5. Zoom e posicionamento.
6. Alteração da proporção.
7. Adição de textos sobre o vídeo.
8. Seleção de fontes.
9. Ajuste de tamanho, cor, contorno e sombra.
10. Posicionamento do texto.
11. Pré-visualização.
12. Exportação usando FFmpeg.

Formatos

Priorizar vídeos verticais 9:16 para Shorts e TikTok, com possibilidade de configurar outros formatos conforme a plataforma.

O sistema deve validar resolução, duração, tamanho e formato antes de exportar ou publicar, usando as regras atualizadas da plataforma de destino.

Tipografia e identidade visual

Disponibilizar um conjunto inicial de fontes legíveis e visualmente profissionais.

Cada projeto poderá salvar seus próprios presets, por exemplo:

* Fonte e tamanho.
* Cor e contorno.
* Posição vertical.
* Margens de segurança.
* Animação simples.
* Estilo de destaque de palavras, se implementado posteriormente.

A interface deve oferecer uma prévia das áreas potencialmente cobertas por botões e informações da plataforma.

Versionamento

O editor não deve sobrescrever o arquivo original.

Um conteúdo pode ter várias versões:

Conteúdo: MMA Drop 001
│
├── Original.mp4
├── Versão A — Clean 9:16.mp4
├── Versão B — Texto e zoom.mp4
└── Versão C — Legendas.mp4

Cada versão deve manter referência ao conteúdo original e às configurações de edição.

Isso permite distribuir versões diferentes do mesmo vídeo para diferentes plataformas.

Funcionalidades futuras

* Legendas automáticas.
* Transcrição.
* Destaque de palavras.
* Modelos de edição.
* Edição em lote.
* Correção de áudio.
* Ajustes automáticos de enquadramento.
* Criação de várias versões em uma operação.

⸻

8. Distribuição de conteúdo em múltiplas plataformas

A publicação deve ser organizada a partir do conteúdo, e não de uma conta específica.

O usuário escolhe um conteúdo, uma versão e os destinos.

Exemplo

CONTEÚDO: MMA Drop 001
          │
          ├── Versão A — Clean 9:16
          │       ├── TikTok MMA
          │       └── YouTube MMA
          │
          └── Versão B — Texto e zoom
                  ├── TikTok Futebol
                  └── YouTube Futebol

O exemplo ilustra a estrutura do sistema, não uma recomendação de publicar necessariamente o mesmo vídeo em nichos diferentes.

Fluxo de publicação

1. Selecionar o conteúdo.
2. Escolher a versão.
3. Selecionar as contas de destino.
4. Configurar título, legenda, hashtags e demais campos.
5. Definir a data e o horário de cada destino.
6. Verificar se o conteúdo atende às exigências da plataforma.
7. Confirmar a publicação ou o agendamento.
8. Registrar o resultado.
9. Atualizar os status de cada destino.
10. Buscar métricas posteriormente, quando a API permitir.

Publicações independentes

Cada destino precisa ter seu próprio registro.

Se um vídeo for enviado a três contas, o sistema deverá registrar três tarefas independentes. Uma falha no TikTok não deve impedir uma publicação bem-sucedida no YouTube.

Conectores de plataforma

Cada rede deve implementar uma interface comum, mas pode oferecer capacidades diferentes.

Por exemplo:

* Publicação direta.
* Upload para conclusão manual na plataforma.
* Agendamento local.
* Consulta de métricas.
* Leitura de comentários.
* Resposta a comentários.
* Moderação.
* Leitura de notificações.

O aplicativo deve indicar claramente quais recursos estão disponíveis para cada conta.

Regras de integração

Utilizar APIs oficiais, OAuth e permissões concedidas pelo usuário. Respeitar limites de uso, auditorias, políticas e requisitos de publicação de cada plataforma.

Não implementar técnicas para ocultar automação, contornar sistemas de detecção ou simular usuários humanos. A experiência pode ser independente das interfaces das redes sociais sem esconder a natureza das integrações.

Quando uma plataforma não permitir determinada ação por API, apresentar uma alternativa oficial, como concluir a operação na própria plataforma.

⸻

9. Fila de publicação e calendário

Criar uma seção chamada Fila, além de um Calendário.

Fila

A fila deve mostrar todos os conteúdos preparados para publicação.

Exemplo:

FILA DE PUBLICAÇÃO
Hoje
├── 12:00 — MMA Drop 001 → TikTok MMA
├── 15:00 — Skate Drop 004 → YouTube Skate
└── 19:00 — Futebol Drop 002 → TikTok Futebol
Amanhã
├── 12:00 — Basquete Drop 003 → YouTube Basquete
└── 18:00 — MMA Drop 005 → YouTube MMA

Requisitos

* Criar uma fila por conta ou destino.
* Definir frequência desejada por conta.
* Configurar dias e horários preferenciais.
* Arrastar e reorganizar tarefas, se viável.
* Reagendar uma tarefa.
* Pausar ou cancelar uma publicação.
* Repetir uma programação.
* Mostrar erros e tarefas pendentes.
* Impedir que a mesma tarefa seja publicada duas vezes por acidente.
* Permitir publicar imediatamente ou agendar para depois.

A frequência é uma preferência de planejamento, não uma promessa de alcance ou desempenho.

Calendário

Criar visualizações diária, semanal e mensal.

Cada publicação deve indicar:

* Conteúdo.
* Projeto.
* Conta.
* Plataforma.
* Horário.
* Status.

O mesmo conteúdo poderá aparecer em vários horários se estiver destinado a diferentes contas.

Interface de horário

Usar um seletor de data e horário simples, com possibilidade de editar cada destino individualmente.

A publicação agendada deve ser executada por um serviço local confiável. A aplicação precisa explicar que o computador pode precisar estar ligado e que o processo local deve estar em execução. Quando uma plataforma oferecer agendamento próprio por API, avaliar essa opção.

⸻

10. Caixa de entrada unificada — Inbox

Criar uma seção central chamada Inbox, reunindo comentários, notificações e interações disponíveis nas plataformas conectadas.

A intenção é que o usuário não precise abrir cada rede social para verificar se alguém comentou ou interagiu com os conteúdos.

Exemplo

INBOX
[ TikTok · MMA ]
Novo comentário em MMA Drop 001
"Qual é o nome desse lutador?"
[ YouTube · Futebol ]
Novo comentário em Futebol Drop 002
"Esse lance foi absurdo!"
[ YouTube · Skate ]
Novo comentário em Skate Drop 004
"Qual é o modelo do skate?"

Funcionalidades

* Lista unificada.
* Filtros por projeto.
* Filtros por plataforma.
* Filtros por conta.
* Filtros por conteúdo.
* Marcar como lido.
* Marcar como resolvido.
* Abrir o conteúdo relacionado.
* Responder quando a API permitir.
* Acessar a publicação original.
* Verificar o estado da sincronização.
* Indicar quais plataformas não oferecem acesso à função desejada.

Assistência por IA

Futuramente, adicionar:

* Sugestões de respostas.
* Resumo de comentários.
* Identificação de perguntas frequentes.
* Agrupamento de comentários por tema.
* Identificação de feedback positivo ou negativo.
* Sugestões de melhorias para conteúdos futuros.

As respostas geradas por IA devem ficar como sugestões para revisão humana. Não implementar respostas automáticas como comportamento padrão.

Limitação importante

Não presumir que todas as plataformas disponibilizam todos os comentários, notificações ou recursos de resposta por API. Implementar apenas os recursos autorizados e documentados, e manter os demais claramente identificados como indisponíveis ou dependentes de aprovação.

⸻

11. Analytics por conteúdo, projeto e rede social

Criar uma seção chamada Analytics, com diferentes níveis de análise.

A. Analytics geral

O painel geral deve ajudar a responder:

* Qual rede social gera mais visualizações?
* Qual rede social gera mais engajamento?
* Qual rede social gera mais seguidores ou inscritos?
* Qual rede gera maior tempo de visualização?
* Quais conteúdos funcionam melhor em cada plataforma?
* Qual projeto apresenta melhor desempenho?
* Quais formatos e durações apresentam resultados melhores?
* Os mesmos vídeos apresentam resultados diferentes em cada rede?
* Quais estratégias merecem ser testadas novamente?

Exemplo conceitual:

ANALYTICS GERAL
Conteúdos publicados: 120
Visualizações totais: [dados disponíveis]
Engajamento: [dados disponíveis]
Seguidores/inscritos ganhos: [dados disponíveis]
Comparação de plataformas
├── TikTok
├── YouTube
└── Instagram
Comparação de projetos
├── MMA
├── Futebol
├── Basquete
├── Skate
└── Projeto 5

Os números acima devem ser calculados a partir de dados reais. Não utilizar números fictícios como se fossem resultados reais.

B. Analytics por projeto

Exibir métricas específicas de cada nicho e permitir comparar projetos.

C. Analytics por plataforma

Permitir estudar as diferenças entre redes sociais.

D. Analytics por conteúdo

Cada conteúdo deverá ter uma página de desempenho, mostrando os resultados de cada publicação e destino.

Métricas prioritárias

* Visualizações.
* Curtidas.
* Comentários.
* Compartilhamentos.
* Inscritos ou seguidores ganhos.
* Tempo total de visualização.
* Duração média da visualização.
* Retenção, quando disponível.
* Taxa de engajamento, com fórmula claramente definida.
* Cliques ou conversões, quando houver dados disponíveis.

Não comparar métricas que tenham definições incompatíveis sem explicar a diferença.

Comparação entre plataformas

O sistema deve permitir comparar o mesmo conteúdo em diferentes redes.

Exemplo:

CONTEÚDO: MMA Drop 001
                 TikTok       YouTube
Visualizações    [dados]      [dados]
Curtidas         [dados]      [dados]
Comentários      [dados]      [dados]
Compartilhamentos[dados]      [dados]
Seguidores ganhos[dados]      [dados]

Os dados devem estar associados ao mesmo identificador interno de conteúdo, mesmo quando o vídeo for exportado em versões diferentes.

Histórico de métricas

Armazenar snapshots de métricas ao longo do tempo, quando as APIs permitirem.

Isso permite visualizar a evolução após a publicação, em vez de guardar apenas o número mais recente.

Exemplo de intervalos de análise:

* Primeiras horas.
* 24 horas.
* 7 dias.
* 30 dias.

Esses intervalos são referências para relatórios, não garantias de que todas as APIs forneçam dados com essa frequência.

Limitações

As métricas disponíveis variam por plataforma, conta, permissão e tipo de conteúdo. O sistema deve mostrar quando um dado não estiver disponível e não inventar valores para preencher lacunas.

⸻

12. Analytics inteligente e aprendizado

Depois que houver volume suficiente de dados, o sistema poderá começar a identificar padrões.

A intenção é ajudar o usuário a tomar decisões melhores, não prometer viralização.

Exemplos de perguntas

* Vídeos de qual duração funcionam melhor no projeto MMA?
* Qual plataforma costuma gerar mais visualizações para vídeos de futebol?
* Vídeos com texto na tela têm desempenho diferente dos vídeos sem texto?
* Qual horário apresenta melhores resultados históricos?
* Vídeos com determinado estilo de edição retêm mais espectadores?
* O mesmo conteúdo funciona melhor em qual rede?
* Qual projeto converte mais visualizações em seguidores?

Comparações necessárias

Para evitar conclusões equivocadas, o sistema deve considerar:

* Quantidade de publicações analisadas.
* Diferenças de audiência.
* Data e horário.
* Duração.
* Formato.
* Versão do vídeo.
* Idade da publicação.
* Métricas específicas de cada plataforma.

Os resultados devem ser apresentados como tendências e hipóteses, com indicação da quantidade de dados utilizada.

Não concluir que uma estratégia causa maior alcance apenas porque dois eventos ocorreram juntos.

Sugestões automáticas futuras

* Recomendar testes de duração.
* Identificar conteúdos que merecem novas versões.
* Sugerir horários para experimentação.
* Sugerir variações de título, texto ou edição.
* Identificar diferenças entre plataformas.
* Propor ajustes no fluxo da Drop Machine.

A integração de feedback da Analytics com a Drop Machine é uma etapa futura, não um requisito inicial.

⸻

13. Dashboard inicial

A tela inicial deve funcionar como um resumo operacional.

Elementos sugeridos

* Conteúdos que precisam de revisão.
* Últimos vídeos importados.
* Publicações agendadas.
* Publicações que falharam.
* Próximas publicações.
* Notificações recentes.
* Comentários pendentes.
* Resumo das métricas disponíveis.
* Estado das contas conectadas.
* Atalhos para importar ou editar um vídeo.

Navegação principal

SOCIAL MACHINE
Dashboard
Conteúdo
├── Biblioteca
├── Editor
├── Fila
└── Modelos
Calendário
Inbox
Analytics
├── Geral
├── Por projeto
├── Por plataforma
└── Por conteúdo
Contas
Projetos
Configurações

A interface deve ser organizada, rápida e funcional, sem excesso de informações na tela inicial.

⸻

14. Modelo de dados

O banco de dados deve ser planejado desde o início para suportar vários projetos, versões, contas, destinos e métricas.

Entidades principais

Project

* id
* name
* description
* category
* settings
* created_at

Platform

* id
* name
* capabilities
* configuration

Account

* id
* platform_id
* external_account_id
* display_name
* project associations
* connection_status
* token reference
* created_at
* updated_at

Content

* id
* project_id
* title
* source_file_path
* thumbnail_path
* duration
* source_type
* imported_at
* status
* metadata

ContentVersion

* id
* content_id
* version_name
* file_path
* edit_settings
* duration
* resolution
* aspect_ratio
* created_at

Publication

* id
* content_id
* content_version_id
* account_id
* caption
* title
* scheduled_at
* published_at
* external_post_id
* status
* error_message

MetricSnapshot

* id
* publication_id
* captured_at
* views
* likes
* comments
* shares
* watch_time
* average_view_duration
* followers_gained
* additional_metrics

InboxItem

* id
* account_id
* publication_id
* external_item_id
* item_type
* text
* author
* created_at
* read_status
* response_status

QueueSettings

* id
* account_id
* preferred_days
* preferred_times
* frequency
* timezone
* enabled

EditPreset

* id
* project_id
* name
* settings

Task

* id
* task_type
* status
* progress
* retry_count
* error_message
* created_at
* updated_at

Regras importantes

* Utilizar identificadores internos estáveis.
* Não depender apenas do nome do arquivo para identificar conteúdos.
* Registrar o vínculo entre conteúdo original, versões e publicações.
* Uma publicação por destino deve possuir seu próprio status.
* Evitar publicações duplicadas com identificadores de tarefa e mecanismos de idempotência.
* Armazenar os tokens de forma segura, separados dos metadados comuns.
* Não guardar tokens ou segredos em logs.
* Planejar migrações do SQLite para futuras versões do aplicativo.

⸻

15. Arquitetura interna dos conectores

Cada plataforma deve ter um módulo independente.

Interface conceitual:

interface SocialConnector {
  connect(): Promise<void>;
  disconnect(accountId: string): Promise<void>;
  getCapabilities(accountId: string): Promise<Capabilities>;
  publish(
    accountId: string,
    content: PublicationPayload
  ): Promise<PublicationResult>;
  getMetrics?(
    accountId: string,
    externalPostId: string
  ): Promise<Metrics>;
  getInboxItems?(
    accountId: string
  ): Promise<InboxItem[]>;
  replyToComment?(
    accountId: string,
    commentId: string,
    text: string
  ): Promise<ReplyResult>;
}

O código acima é apenas uma interface ilustrativa. A implementação real deve considerar os fluxos, requisitos, escopos e limitações de cada API.

Nem todas as funções estarão disponíveis em todos os conectores. A interface visual deve consultar as capacidades antes de oferecer uma ação.

Recuperação de erros

O sistema deve tratar:

* Tokens expirados.
* Permissões revogadas.
* Limites de API.
* Erros de rede.
* Arquivos inválidos.
* Falhas de renderização.
* Publicações rejeitadas.
* Dados indisponíveis.
* Tarefas interrompidas.

Quando uma tarefa puder ser repetida com segurança, oferecer uma opção de nova tentativa.

⸻

16. Segurança e conformidade

* Utilizar APIs oficiais.
* Utilizar OAuth quando necessário.
* Armazenar tokens de forma protegida.
* Não registrar credenciais em logs.
* Permitir revogar e desconectar acessos.
* Respeitar permissões concedidas por cada plataforma.
* Respeitar limites de requisições.
* Validar os arquivos antes de enviar.
* Manter os arquivos originais.
* Não contornar sistemas de detecção ou mecanismos de segurança das plataformas.
* Não simular comportamento humano para disfarçar automação.
* Não prometer alcance, viralização ou ausência de penalizações.

O aplicativo pode oferecer uma interface centralizada e independente sem precisar imitar o comportamento de uma pessoa dentro das plataformas.

⸻

17. Plano de desenvolvimento por fases

A prioridade é criar um aplicativo realmente funcional em etapas, evitando começar com dezenas de integrações simultaneamente.

Fase 1 — Base funcional

Objetivo: construir o núcleo da Social Machine.

Implementar:

* Estrutura desktop.
* Navegação.
* Banco SQLite.
* Projetos.
* Biblioteca de conteúdo.
* Importação manual.
* Monitoramento de uma pasta configurável.
* Integração inicial com a saída da Drop Machine.
* Preview de vídeos.
* Registro de status.

Resultado esperado: novos clipes da Drop Machine aparecem na biblioteca da Social Machine.

Fase 2 — Editor

Implementar:

* Preview.
* Corte inicial e final.
* Recorte e zoom.
* Texto sobreposto.
* Fontes.
* Presets.
* Exportação por FFmpeg.
* Versionamento de arquivos.

Resultado esperado: o usuário consegue preparar e exportar vídeos sem abrir outro editor.

Fase 3 — Contas e publicação

Começar por uma plataforma, preferencialmente YouTube ou a plataforma cuja API esteja mais viável para o caso de uso.

Implementar:

* Conexão oficial.
* Listagem de contas.
* Seleção de destinos.
* Campos de publicação.
* Envio de conteúdo.
* Histórico.
* Tratamento de erros.

Depois, implementar o TikTok e as demais plataformas.

Resultado esperado: o usuário consegue publicar conteúdos por meio de integrações oficiais.

Fase 4 — Fila e calendário

Implementar:

* Agendamento.
* Fila por conta.
* Calendário.
* Reagendamento.
* Cancelamento.
* Controle de tarefas.
* Prevenção de duplicação.
* Retomada de tarefas interrompidas.

Resultado esperado: o usuário consegue organizar publicações futuras.

Fase 5 — Analytics

Implementar:

* Métricas por publicação.
* Histórico de métricas.
* Comparação por conta.
* Comparação por projeto.
* Analytics geral.
* Gráficos e filtros.
* Indicação de dados indisponíveis.

Resultado esperado: o usuário consegue comparar o desempenho das publicações nas redes conectadas.

Fase 6 — Inbox

Implementar, conforme as permissões de cada plataforma:

* Comentários.
* Notificações disponíveis.
* Filtros.
* Marcação como lido.
* Respostas autorizadas.
* Histórico de interações.

Resultado esperado: o usuário acompanha as interações disponíveis em uma interface central.

Fase 7 — Inteligência e otimização

Implementar:

* Comparações históricas.
* Identificação de tendências.
* Sugestões de experimentos.
* Recomendações por projeto.
* Assistência de IA para respostas e legendas.
* Integração futura dos aprendizados com a Drop Machine.

Resultado esperado: a Social Machine ajuda o usuário a entender o que funciona melhor e a planejar novos conteúdos.

⸻

18. Critérios de qualidade

A aplicação não deve ser considerada pronta apenas porque a interface está visualmente concluída.

Cada funcionalidade deve ter um fluxo real de uso e tratamento de erros.

Critérios essenciais

* Os projetos persistem após reiniciar o aplicativo.
* Os vídeos importados continuam acessíveis.
* A edição gera arquivos reais.
* Os originais não são sobrescritos.
* A fila persiste após reiniciar.
* Os status de publicação são registrados corretamente.
* Uma falha em uma plataforma não bloqueia outras.
* A conta desconectada não impede o uso das funções locais.
* Os gráficos utilizam dados reais.
* As limitações das APIs são informadas claramente.
* A aplicação não duplica conteúdos ao monitorar pastas.
* Os logs permitem diagnosticar erros sem expor credenciais.

⸻

19. O que não desenvolver inicialmente

Para manter o projeto viável, evitar na primeira versão:

* Editor de vídeo profissional completo.
* Aplicativo mobile.
* Publicação em todas as redes simultaneamente.
* IA avançada de análise de viralização.
* Automação de respostas sem revisão.
* Sistema complexo de equipes e permissões.
* Hospedagem em nuvem obrigatória.
* Sincronização de grandes arquivos de vídeo pela internet.
* Integração automática de analytics com a lógica interna da Drop Machine.

Essas funcionalidades podem ser adicionadas posteriormente, quando o núcleo estiver estável.

⸻

20. Instruções para a IA que vai desenvolver o projeto

Você é responsável por ajudar a transformar a especificação da Social Machine em um aplicativo funcional.

Antes de escrever grandes quantidades de código:

1. Inspecione os arquivos e a estrutura do projeto, caso já existam.
2. Identifique a versão e a arquitetura da Drop Machine, se o código estiver disponível.
3. Verifique o ambiente de desenvolvimento e as dependências.
4. Separe requisitos implementáveis localmente dos que dependem de APIs externas.
5. Confirme as capacidades atuais e os requisitos de autenticação das APIs que serão utilizadas.
6. Proponha uma arquitetura concreta e um plano de execução.
7. Defina o modelo de dados e as interfaces dos conectores.
8. Implemente em pequenas etapas testáveis.

Não afirme que uma funcionalidade está implementada se existir apenas uma interface visual ou um mock.

Quando alguma API exigir aprovação, credenciais ou configuração externa, construa a integração até o limite possível, documente os passos restantes e não invente credenciais nem resultados.

Não reescreva a Drop Machine desnecessariamente. Prefira integrar os dois aplicativos por meio de pastas configuráveis, metadados ou uma API local bem definida.

Primeira tarefa recomendada

Comece pela Fase 1 — Base funcional.

Entregue primeiro:

* Estrutura de pastas.
* Configuração do aplicativo desktop.
* Modelo inicial do banco SQLite.
* Sistema de projetos.
* Biblioteca de conteúdo.
* Importação manual de vídeos.
* Monitoramento configurável da pasta de saída da Drop Machine.
* Dashboard inicial.
* Testes básicos de persistência e importação.
* Instruções claras para executar no Windows.

Após validar essa base, prossiga para o editor de vídeo e as demais fases.

Princípio final: construir uma plataforma modular, local-first e funcional, na qual cada conteúdo tenha identidade própria, possa gerar múltiplas versões, ser distribuído para vários destinos e ter seu desempenho analisado ao longo do tempo.
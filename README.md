# Social Machine

Central local de conteúdo para vídeos curtos: biblioteca, organização por projetos e, nas próximas fases, edição, distribuição, agendamento e análise em várias redes. Funciona junto com a **Drop Machine**: ela encontra os momentos e gera os clipes; a Social Machine organiza, prepara e (futuramente) publica.

Windows 10/11, local-first. Electron + React + TypeScript + Vite, SQLite (better-sqlite3), FFmpeg 9 (LGPL) incluído.

**Estado atual: Fase 3 (contas e publicação).** Projetos, biblioteca de vídeos com metadados reais, importação manual, monitoramento da pasta de saída da Drop Machine com execução na área de notificação, e um editor que exporta versões (corte, proporção, enquadramento, textos, presets) sem nunca alterar o original. Publica no YouTube pela API oficial e registra publicações manuais no TikTok e no Instagram. O banco já está preparado para métricas, inbox e fila. Veja [`PROJECT_STATUS.md`](PROJECT_STATUS.md) para o que foi validado e o que ainda falta. O plano completo está em [`docs/SPEC.md`](docs/SPEC.md).

## Requisitos

- Windows 10 ou 11 (x64)
- [Node.js](https://nodejs.org/) **22.13 ou mais novo** (22 LTS recomendado)
- Git (opcional)

O `npm install` precisa de internet: além dos pacotes npm, baixa o FFmpeg fixado (~77 MB, verificado por SHA-256) para `vendor/ffmpeg/`. Detalhes em [docs/FFMPEG.md](docs/FFMPEG.md).

O `better-sqlite3` é um módulo nativo. O `npm install` baixa um binário pronto para o Electron (`electron-builder install-app-deps` no `postinstall`). Só se esse download falhar ele tenta compilar, o que exige o Visual Studio Build Tools com "Desktop development with C++".

## Instalar e rodar

```powershell
cd social-machine
npm install
npm run dev
```

`npm run dev` abre a janela do Electron com recarga automática.

Se o `npm install` não conseguiu baixar o FFmpeg (offline, proxy), o app abre mas a Biblioteca avisa que a importação está indisponível. Para resolver:

```powershell
npm run fetch:ffmpeg
```

Para gerar o instalador do Windows (inclui o FFmpeg):

```powershell
npm run dist:win
```

O instalador fica em `dist\`. Cada push no GitHub também gera o instalador no CI (artefato `windows-installer`). Ele não é assinado, então o Windows SmartScreen vai avisar na primeira execução.

## Usando

### Projetos

Em **Projetos**, crie um projeto por nicho (ou use **Criar MMA, Futebol, Basquete e Skate**). Cada projeto tem cor, categoria, descrição, hashtags padrão e modelo de descrição (os dois últimos serão usados na publicação, Fase 3). Excluir um projeto nunca apaga conteúdos: eles ficam na biblioteca como "Sem projeto".

### Biblioteca

- **Importar vídeos…** / **Importar pasta…**, ou arraste vídeos e pastas para a janela. Com um projeto selecionado no filtro, o botão importa direto para ele.
- Cada arquivo é verificado pelo FFprobe e por uma decodificação curta. Arquivos danificados, imagens paradas e arquivos só de áudio são recusados com uma mensagem clara.
- Cada conteúdo mostra miniatura, duração, resolução, proporção (9:16, 16:9…), quadros por segundo, projeto, origem e status.
- Status editorial: **Importado**, **Precisa de revisão**, **Em edição**, **Pronto**, **Arquivado**. É separado do estado do arquivo (analisando, com erro, ausente).
- Selecione vários cards (caixinha no canto, Shift para intervalo) para mudar status ou projeto em lote.
- Os arquivos continuam onde estão. A biblioteca guarda referência, metadados e miniatura. **Tirar da biblioteca** nunca apaga o arquivo.
- O mesmo vídeo não entra duas vezes: nem pelo caminho, nem como cópia com outro nome. Um arquivo **renomeado** é reconhecido pelo conteúdo e o item existente passa a apontar para o novo nome, mantendo projeto e status.
- Arquivo movido aparece como **Arquivo ausente** e mantém os metadados. Use **Localizar…** ou **Procurar numa pasta…**.

### Editor

Na Biblioteca, abra um vídeo e clique em **Abrir no editor** (ou use **Editor** no menu e escolha um vídeo).

- **Formato:** proporção 9:16 (1080×1920), 16:9, 1:1, 4:5 ou original. **Preencher** corta as bordas; **Mostrar tudo** mostra o vídeo inteiro com fundo desfocado ou preto. Zoom e posição pelos controles ou **arrastando o vídeo na prévia**.
- **Corte:** arraste as alças da barra, ou use **Início aqui** / **Fim aqui** na posição atual. Espaço reproduz e pausa (a prévia repete o trecho cortado).
- **Textos:** vários por vídeo, com fonte (Montserrat, Anton, Bebas Neue, Oswald, Bangers incluídas, mais Arial Black, Impact, Segoe UI e Georgia do Windows), tamanho, negrito, maiúsculas, cor, contorno, sombra, caixa de fundo, alinhamento e tempo de exibição. Arraste o texto na prévia para posicioná-lo.
- **Guias:** no 9:16, a prévia mostra (aproximadamente) as áreas cobertas pela interface do TikTok, Reels ou Shorts.
- **A prévia é o resultado:** o texto é desenhado pelo mesmo código na prévia e no vídeo exportado.
- **Exportar versão:** cria uma versão com nome (Versão A, B…) em `exports\<projeto>\<título> - <versão>.mp4`, em H.264 + AAC. A exportação roda em segundo plano, com progresso e cancelamento. O arquivo é conferido com o FFprobe antes de ficar pronto. O original nunca é alterado.
- **Versões:** listadas no editor e no painel do vídeo na Biblioteca, com **Assistir**, **Mostrar na pasta**, **Editar como nova**, **Tentar de novo** e **Excluir** (com ou sem o arquivo).
- **Presets:** salve proporção, enquadramento e estilo dos textos para o projeto ou para todos, e aplique em outros vídeos.
- **Codificador:** usa a placa de vídeo (NVIDIA, Intel ou AMD) quando ela funciona e o OpenH264 quando não há. Dá para forçar o OpenH264 em Configurações.

### Contas e publicação

Em **Contas**:

- **YouTube (API oficial):** configure uma vez o Client ID e a chave secreta. O passo a passo está na própria tela: projeto no Google Cloud, YouTube Data API v3, tela de consentimento com você como usuário de teste, ID do cliente do tipo "App para computador". Depois clique em **Conectar canal do YouTube**: o navegador abre, você autoriza e o app volta sozinho.
  - Com o projeto do Google em modo "Teste", o login expira a cada 7 dias. A conta aparece como "Login expirado"; é só **Reconectar**, e o histórico continua.
  - A API permite 100 envios por dia por projeto do Google.
- **TikTok e Instagram (manual):** adicione o perfil (por exemplo, `@mma.cortes`). A publicação direta pelas APIs deles exige aprovação do app (no TikTok, apps não auditados só publicam como privado). Então o app prepara tudo e você confirma depois de publicar.
- Associe cada conta aos projetos (botões de projeto na conta). Os tokens ficam criptografados pelo Windows, nunca no banco nem nos logs. **Desconectar** revoga o acesso e mantém o histórico.

Para publicar: numa versão pronta (no editor ou no painel do vídeo na Biblioteca), clique em **Publicar…**.

- Escolha os destinos. As contas do projeto do vídeo já vêm marcadas.
- Preencha título, legenda e hashtags; as hashtags e o modelo de descrição do projeto vêm preenchidos.
- Para o YouTube: visibilidade, categoria e "feito para crianças" (obrigatório).
- Cada destino vira uma publicação independente: uma falha não afeta as outras.
- O envio ao YouTube roda em segundo plano, com progresso. Se a internet cair ou o app fechar, ele continua de onde parou.
- Nas manuais: **Abrir TikTok**, **Mostrar arquivo**, **Copiar legenda** e **Já publiquei** (com o link, se quiser).
- Publicar a mesma versão de novo na mesma conta pede confirmação.

### Fila e calendário

No diálogo **Publicar…**, em **Quando**, escolha **Agora** ou **Agendar** (data e hora, ou **Próximo horário livre**).

- **YouTube:** por padrão o agendamento é feito no próprio YouTube. O vídeo sobe na hora como privado e fica público sozinho no horário, mesmo com o computador desligado. Depois disso, mudanças só pelo YouTube Studio. Também dá para escolher "Enviar no horário".
- **Outros agendamentos** rodam no app: ele precisa estar aberto no horário (pode ficar na bandeja). Para TikTok e Instagram chega um aviso do Windows na hora de publicar.
- Se o computador estava desligado, nada sai atrasado sem você: a publicação aparece em **Precisa de você** para **Publicar agora** ou **Reagendar**. Até 15 minutos de atraso, ela sai normalmente.

Em **Fila**: o que precisa de você, o que está enviando, as agendadas por dia e as publicadas recentemente. Cada uma tem **Publicar agora**, **Reagendar**, **Pausar**/**Retomar** e **Cancelar**. Na lateral, **Horários de postagem** define dias e horários preferidos de cada conta (usados no "Próximo horário livre").

Em **Calendário**: visão de mês, semana e dia, com filtro por projeto e conta. A cor da borda é o projeto. Arraste uma publicação para outro dia para reagendar (mantém o horário).

### Analytics

Em **Analytics**:

- **YouTube:** as métricas são coletadas sozinhas (a cada poucas horas nos primeiros dias, depois com menos frequência) ou na hora, com **Atualizar métricas**. Visualizações, curtidas e comentários vêm da API de dados. Tempo assistido, compartilhamentos, inscritos ganhos e retenção vêm do **YouTube Analytics**, que costuma ter 1 a 3 dias de atraso.
  - Ative a **YouTube Analytics API** no mesmo projeto do Google Cloud (APIs e serviços → Biblioteca). Sem ela, o app avisa e mostra só visualizações, curtidas e comentários.
- **TikTok e Instagram:** abra o conteúdo (clique na tabela de conteúdos ou em **Ver desempenho** na Biblioteca) e copie os números do app da plataforma. Eles ficam marcados como "informado por você".
- Filtros: período (7, 30, 90 dias ou tudo), projeto, plataforma e conta.
- **Comparar por** plataforma, projeto, conta, formato ou duração, com gráfico e tabela.
- A página de cada conteúdo compara todos os destinos lado a lado, com visualizações em 24 h, 7 e 30 dias e um gráfico da evolução.
- Nada é estimado: o que falta aparece como "indisponível". Engajamento = (curtidas + comentários + compartilhamentos) ÷ visualizações.

### Inbox

Em **Inbox** ficam os comentários dos seus vídeos do YouTube, sincronizados a cada 15 minutos ou na hora, com **Sincronizar**.

- Filtros: não lidos, abertos, todos ou resolvidos, além de projeto, plataforma, conta, conteúdo e busca por texto ou autor.
- Clique num comentário para ver a conversa. Abrir marca como lido.
- Use **Marcar como resolvido**, **Abrir no YouTube** ou **Abrir conteúdo**, que leva à página de desempenho.
- **Responder:** você escreve e clica em **Enviar resposta**. A resposta sai pública, pelo seu canal. Nada é respondido automaticamente.
  - Se a conta foi conectada antes desta versão, reconecte em **Contas** para autorizar as respostas. O Google vai pedir a permissão de "gerenciar sua conta do YouTube".
  - Cada resposta gasta 50 unidades da cota diária da API (10.000 por padrão).
- **TikTok e Instagram:** as APIs de comentários exigem app aprovado pela plataforma, então a Inbox mostra isso e os comentários continuam no app deles.
- Na primeira sincronização, comentários com mais de 7 dias entram como já lidos.

### Pasta da Drop Machine

Em **Configurações → Pastas monitoradas**, use **Adicionar pasta da Drop Machine…** e escolha a pasta de saída (normalmente `C:\drop-machine\public\output`). Escolha também o projeto que os vídeos novos devem receber.

- Vídeos que já estão na pasta são importados na hora. Os novos aparecem sozinhos como **Precisa de revisão**.
- Um vídeo só é importado depois que **parou de crescer** (tamanho e data iguais em verificações seguidas) e pode ser aberto para leitura. Renderizações em andamento não entram pela metade. Nomes temporários (`.part`, `.tmp`, `.crdownload`…) e arquivos ocultos são ignorados.
- Três mecanismos garantem que nada se perca: eventos do sistema de arquivos (detecção imediata), varredura periódica (padrão: a cada 60 s) e **reconciliação ao iniciar**, que importa o que foi criado com o app fechado.
- Nada dentro das pastas monitoradas é movido, renomeado ou apagado.
- Você pode monitorar outras pastas também (**Adicionar outra pasta…**).

### Segundo plano e área de notificação

- Fechar a janela **não encerra** o app: ele continua no ícone perto do relógio, monitorando as pastas. Para sair de vez, clique com o botão direito no ícone → **Sair**.
- **Configurações → Iniciar com o Windows** abre o app minimizado no ícone ao entrar no Windows.
- Só pode existir uma instância. Abrir o app de novo apenas mostra a janela existente.
- Com o app encerrado ou o computador desligado, nada é monitorado. Na próxima abertura a reconciliação importa o que chegou nesse intervalo. Não há serviço do Windows separado (veja `TECHNICAL_DECISIONS.md`, TD-105).

## Scripts

```powershell
npm run dev            # desenvolvimento, recarga automática
npm run build          # build de produção em out/
npm start              # roda o build de produção
npm test               # testes unitários (Vitest), incluindo FFmpeg real
npm run typecheck      # TypeScript estrito: main, renderer, E2E
npm run test:e2e       # build + Playwright dirigindo o app real
npm run dist:win       # instalador do Windows em dist/ (com FFmpeg)
npm run test:packaged  # Playwright contra dist/win-unpacked (depois do dist:win)
npm run fetch:ffmpeg   # (re)instala o FFmpeg fixado em vendor/ffmpeg
```

## Onde ficam os dados

Padrão: `Documentos\SocialMachine\`

```
SocialMachine\
├── app-data\
│   ├── database.sqlite      SQLite: projetos, conteúdos, pastas, configurações (+ tabelas das próximas fases)
│   ├── backups\             cópia automática antes de cada migração do banco
│   ├── logs\app.log         JSON por linha, rotação a cada 5 MB (3 arquivos)
│   ├── thumbnails\          miniaturas (um JPEG por vídeo)
│   ├── temp\                arquivos de trabalho; sobras são apagadas ao iniciar
│   ├── versions\            imagens dos textos de cada versão (para refazer uma exportação)
│   ├── secrets\             tokens e chave do YouTube, criptografados pelo Windows
│   └── projects, proxies, presets\   (próximas fases)
└── exports\                 versões exportadas, uma subpasta por projeto
```

- Mude a pasta de dados em **Configurações → Armazenamento** (vale depois de reiniciar; os dados atuais não são movidos).
- `SM_DATA_DIR` substitui tudo (usado pelos testes E2E; útil para um perfil de teste descartável):

  ```powershell
  $env:SM_DATA_DIR = "C:\Temp\sm-test"; npm run dev
  ```

- `SM_FFMPEG_DIR` aponta para outra pasta do FFmpeg (com `bin/ffmpeg.exe` e `bin/ffprobe.exe`). Só para diagnóstico.
- `SM_DISABLE_TRAY=1` desliga o ícone na área de notificação (fechar a janela encerra o app).

## Estrutura

```
src/
├── shared/        tipos, schemas zod, nomes dos canais IPC (usados por todos os processos)
├── main/          processo principal do Electron
│   ├── db/        driver, migrações, abertura + backup do banco
│   ├── ipc/       tabela de handlers validados
│   ├── media/     FFmpeg, probe, miniaturas, fila de importação, protocolo sm-media://
│   ├── watch/     monitoramento de pastas (eventos + varredura + estabilidade)
│   ├── editor/    plano de renderização FFmpeg, escolha do codificador, fila de exportação
│   ├── connectors/ YouTube (OAuth + envio retomável) e destinos manuais
│   ├── publishing/ fila de publicações por destino
│   ├── secrets/   tokens criptografados pelo Windows (safeStorage)
│   ├── repositories/  projetos, conteúdos, pastas monitoradas, configurações
│   └── index.ts   janela, bandeja, instância única, iniciar com o Windows
├── preload/       a única ponte com a interface (window.sm)
└── renderer/      interface React (sem acesso ao Node)
tests/
├── unit/          Vitest em Node puro (node:sqlite, FFmpeg real)
├── e2e/           Playwright dirigindo o app Electron compilado
├── e2e-packaged/  Playwright contra o build do Windows
└── helpers/       vídeos de teste gerados com o FFmpeg incluído
```

A base (banco, IPC, FFmpeg, importação, testes, CI) foi copiada da Music Content Engine e adaptada; veja `TECHNICAL_DECISIONS.md` (TD-101).

## Problemas comuns

**`npm install` falha compilando o better-sqlite3 (node-gyp / MSBuild).** Nenhum binário pronto bateu com a versão do Electron e ele tentou compilar. Instale o [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) com "Desktop development with C++" e rode `npm install` de novo.

**O app abre e mostra "The module … was compiled against a different Node.js version".** O módulo nativo foi compilado para o Node em vez do Electron:

```powershell
npx electron-builder install-app-deps
```

**Um vídeo da Drop Machine não aparece.** Veja o estado da pasta em Configurações (Monitorando / Verificação periódica / Pasta indisponível) e o motivo de erro no card, se houver. Arquivos ainda sendo gravados aparecem como "terminando de gravar". **Verificar agora** força uma varredura. Os detalhes ficam em `app-data\logs\app.log`.

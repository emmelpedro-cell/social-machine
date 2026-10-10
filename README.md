# Social Machine

Central local de conteúdo para vídeos curtos: biblioteca, organização por projetos e, nas próximas fases, edição, distribuição, agendamento e análise em várias redes. Funciona junto com a **Drop Machine**: ela encontra os momentos e gera os clipes; a Social Machine organiza, prepara e (futuramente) publica.

Windows 10/11, local-first. Electron + React + TypeScript + Vite, SQLite (better-sqlite3), FFmpeg 9 (LGPL) incluído.

**Estado atual: Fase 1 (base funcional).** Projetos, biblioteca de vídeos com metadados reais, importação manual, monitoramento da pasta de saída da Drop Machine com execução na área de notificação, e o banco já preparado para versões, contas, publicações, métricas, inbox e tarefas. Veja [`PROJECT_STATUS.md`](PROJECT_STATUS.md) para o que foi validado e o que ainda falta. O plano completo está em [`docs/SPEC.md`](docs/SPEC.md).

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
│   └── projects, proxies, versions, presets\   (próximas fases)
└── exports\                 pasta de exportação padrão
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

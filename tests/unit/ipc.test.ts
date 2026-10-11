import { beforeEach, describe, expect, it } from 'vitest'
import { InboxService } from '../../src/main/inbox/inbox-service'
import { InboxRepository } from '../../src/main/repositories/inbox'
import { MetricsService } from '../../src/main/analytics/metrics-service'
import { MetricsRepository } from '../../src/main/repositories/metrics'
import { QueueSettingsRepository } from '../../src/main/repositories/queue-settings'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ALL_IPC_CHANNELS, IpcChannels } from '../../src/shared/channels'
import type { IpcResult, Project } from '../../src/shared/schemas'
import type { ContentItem, MediaEvent } from '../../src/shared/media'
import type { WatchFolderStatus } from '../../src/shared/watch'
import { runMigrations } from '../../src/main/db/migrations'
import { wrapHandler } from '../../src/main/ipc/handler'
import { buildHandlers, type HandlerTable } from '../../src/main/ipc/handlers'
import { ProjectsRepository } from '../../src/main/repositories/projects'
import { ContentsRepository } from '../../src/main/repositories/contents'
import { ImportService } from '../../src/main/media/import-service'
import { UnavailableError } from '../../src/main/errors'
import { SettingsRepository } from '../../src/main/repositories/settings'
import { createSenderValidator } from '../../src/main/security'
import { WatchFoldersRepository } from '../../src/main/repositories/watch-folders'
import { WatchService } from '../../src/main/watch/watch-service'
import { EncoderSelector, SOFTWARE_ENCODER } from '../../src/main/editor/encoders'
import { RenderService } from '../../src/main/editor/render-service'
import { PresetsRepository } from '../../src/main/repositories/presets'
import { VersionsRepository } from '../../src/main/repositories/versions'
import { AccountsRepository } from '../../src/main/repositories/accounts'
import { PublicationsRepository } from '../../src/main/repositories/publications'
import { PublishService } from '../../src/main/publishing/publish-service'
import { ManualConnector } from '../../src/main/connectors/manual'
import { YouTubeConnector } from '../../src/main/connectors/youtube/connector'
import { YouTubeClientConfig } from '../../src/main/connectors/config'
import { MemorySecretStore } from '../../src/main/secrets/token-store'
import { createNodeSqliteDriver, memoryLogger } from '../helpers/node-sqlite-driver'

function setup() {
  const db = createNodeSqliteDriver()
  runMigrations(db)
  const logger = memoryLogger()
  const mediaRepo = new ContentsRepository(db)
  const events: MediaEvent[] = []
  const watchRepo = new WatchFoldersRepository(db)
  const watchService = new WatchService({
    folders: watchRepo,
    knownFiles: () => mediaRepo.knownFiles(),
    importer: async () => {},
    logger,
    emit: () => {},
    scanIntervalMs: () => 60_000,
    watchFactory: () => ({ close: () => {} })
  })
  const versions = new VersionsRepository(db)
  const noTools = async () => {
    throw new UnavailableError('FFmpeg is missing (test).')
  }
  const renderer = new RenderService({
    versions,
    contents: mediaRepo,
    projectName: () => null,
    getTools: noTools,
    encoders: new EncoderSelector(noTools, logger),
    encoderPreference: () => 'software',
    exportsDirectory: () => '/nonexistent/exports',
    versionsDirectory: '/nonexistent/versions',
    thumbnailsDirectory: '/nonexistent/thumbs',
    tempDirectory: '/nonexistent/temp',
    logger,
    emit: () => {}
  })
  const accounts = new AccountsRepository(db)
  const publications = new PublicationsRepository(db)
  const secrets = new MemorySecretStore()
  const youtubeConfig = new YouTubeClientConfig(db, secrets)
  const youtube = new YouTubeConnector({
    accounts,
    secrets,
    config: youtubeConfig,
    fetch: async () => {
      throw new Error('no network in tests')
    },
    openBrowser: () => {},
    logger
  })
  const publisher = new PublishService({
    publications,
    accounts,
    versions,
    connectors: { youtube, tiktok: new ManualConnector('tiktok'), instagram: new ManualConnector('instagram') },
    logger,
    emit: () => {}
  })
  const opened: string[] = []
  const table = buildHandlers({
    projects: new ProjectsRepository(db),
    settings: new SettingsRepository(db, logger),
    logger,
    rendererLogger: logger,
    getAppInfo: () => {
      throw new Error('internal detail that must not leak')
    },
    openLogsFolder: async () => {},
    chooseDataDirectory: async () => ({ changed: false }),
    chooseExportDirectory: async () => ({ changed: false }),
    media: {
      repo: mediaRepo,
      service: new ImportService({
        repo: mediaRepo,
        getTools: async () => {
          throw new UnavailableError('FFmpeg is missing from this installation. Reinstall Social Machine.')
        },
        thumbnailsDirectory: '/nonexistent/thumbs',
        tempDirectory: '/nonexistent/temp',
        logger,
        emit: (event) => events.push(event)
      }),
      toolsStatus: async () => ({ ok: false, source: 'packaged', directory: '/x', code: 'MISSING', message: 'missing', detail: '' }),
      recheckTools: async () => ({ ok: false, source: 'packaged', directory: '/x', code: 'MISSING', message: 'missing', detail: '' }),
      importWithDialog: async () => ({ cancelled: true }),
      relinkWithDialog: async () => ({ status: 'cancelled' }),
      relinkFolderWithDialog: async () => ({ cancelled: true }),
      showInFolder: () => {}
    },
    watch: {
      repo: watchRepo,
      service: watchService,
      addWithDialog: async () => ({ cancelled: true }),
      openFolder: async () => {}
    },
    editor: {
      versions,
      presets: new PresetsRepository(db),
      renderer,
      encoder: async () => SOFTWARE_ENCODER,
      showVersionInFolder: () => {}
    },
    publishing: {
      accounts,
      publications,
      service: publisher,
      queueSettings: new QueueSettingsRepository(db),
      youtubeConfig,
      connectYouTube: (projectIds) => youtube.connect(projectIds),
      disconnect: async (id) => {
        accounts.disconnect(id)
        return accounts.get(id)
      },
      remove: (id) => {
        accounts.remove(id)
      },
      openExternal: async (url) => {
        opened.push(url)
      }
    },
    analytics: new MetricsService({
      metrics: new MetricsRepository(db),
      accounts,
      publications,
      connectors: { youtube, tiktok: new ManualConnector('tiktok'), instagram: new ManualConnector('instagram') },
      logger,
      emit: () => {},
      tickMs: 0
    }),
    inbox: new InboxService({
      inbox: new InboxRepository(db),
      accounts,
      connectors: { youtube, tiktok: new ManualConnector('tiktok'), instagram: new ManualConnector('instagram') },
      logger,
      emit: () => {},
      tickMs: 0
    })
  })
  const call = <T>(channel: keyof HandlerTable, input?: unknown) =>
    wrapHandler(channel, table[channel], logger)(input) as Promise<IpcResult<T>>
  return { call, logger, table, mediaRepo, watchRepo, watchService, events, opened, secrets }
}

describe('IPC handlers', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => {
    ctx = setup()
  })

  it('has a handler for every declared channel', () => {
    expect(Object.keys(ctx.table).sort()).toEqual([...ALL_IPC_CHANNELS].sort())
  })

  it('creates, lists, updates and deletes projects', async () => {
    const created = await ctx.call<Project>(IpcChannels.projectsCreate, { name: 'MMA', category: 'Esporte' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.data.id

    const list = await ctx.call<Project[]>(IpcChannels.projectsList)
    expect(list.ok && list.data.map((p) => p.id)).toEqual([id])

    const updated = await ctx.call<Project>(IpcChannels.projectsUpdate, { id, name: 'MMA & Boxe' })
    expect(updated.ok && updated.data.name).toBe('MMA & Boxe')

    const duplicate = await ctx.call(IpcChannels.projectsCreate, { name: 'mma & boxe' })
    expect(!duplicate.ok && duplicate.error.code).toBe('CONFLICT')

    expect(await ctx.call(IpcChannels.projectsDelete, { id })).toEqual({ ok: true, data: null })
    const missing = await ctx.call(IpcChannels.projectsGet, { id })
    expect(missing.ok).toBe(false)
    expect(!missing.ok && missing.error.code).toBe('NOT_FOUND')
  })

  it('rejects invalid input before running the handler', async () => {
    const cases: [keyof HandlerTable, unknown][] = [
      [IpcChannels.projectsCreate, { name: '   ' }],
      [IpcChannels.projectsCreate, { name: 'ok', extra: 'not allowed' }],
      [IpcChannels.projectsCreate, { name: 'ok', color: 'red' }],
      [IpcChannels.projectsCreateSuggested, { names: ['x'] }],
      [IpcChannels.projectsCreate, 'just a string'],
      [IpcChannels.projectsGet, { id: 'not-a-uuid' }],
      [IpcChannels.projectsUpdate, { id: '00000000-0000-4000-8000-000000000000' }],
      [IpcChannels.projectsList, { unexpected: true }],
      [IpcChannels.settingsUpdate, { accentColor: 'red' }],
      [IpcChannels.settingsUpdate, { exportDirectory: 'C:\\Windows' }],
      [IpcChannels.logWrite, { level: 'fatal', message: 'x' }],
      [IpcChannels.mediaImportPaths, { paths: [] }],
      [IpcChannels.mediaImportPaths, { paths: 'C:\\Windows' }],
      [IpcChannels.mediaImportPaths, { paths: Array.from({ length: 2001 }, () => '/x.mp4') }],
      [IpcChannels.mediaImportDialog, { mode: 'everything' }],
      [IpcChannels.mediaCancel, { id: '../../etc' }],
      [IpcChannels.mediaRemove, {}],
      [IpcChannels.mediaShowInFolder, { id: 1 }],
      [IpcChannels.mediaRelink, { id: 'x', path: '/etc/passwd' }],
      [IpcChannels.mediaImportPaths, { paths: ['/x.mp4'], projectId: 'not-a-uuid' }],
      [IpcChannels.mediaSetWorkflowStatus, { ids: [], workflowStatus: 'ready' }],
      [IpcChannels.mediaSetWorkflowStatus, { ids: ['00000000-0000-4000-8000-000000000000'], workflowStatus: 'published' }],
      [IpcChannels.mediaSetProject, { ids: ['nope'], projectId: null }],
      [IpcChannels.mediaSetTitle, { id: '00000000-0000-4000-8000-000000000000', title: 'x'.repeat(201) }],
      [IpcChannels.watchAdd, { origin: 'anywhere' }],
      [IpcChannels.watchAdd, { origin: 'drop_machine', path: 'C:\\Windows' }],
      [IpcChannels.watchUpdate, { id: '00000000-0000-4000-8000-000000000000', path: 'C:\\' }],
      [IpcChannels.watchRemove, { id: 'x' }],
      [IpcChannels.settingsUpdate, { watchScanIntervalSeconds: 1 }],
      [IpcChannels.settingsUpdate, { launchAtLogin: 'yes' }],
      [IpcChannels.settingsUpdate, { encoderPreference: 'gpu' }],
      [IpcChannels.versionsCreate, { contentId: '00000000-0000-4000-8000-000000000000', name: 'x', settings: {}, overlays: [] }],
      [IpcChannels.versionsCreate, { contentId: 'nope', name: 'x', settings: {}, overlays: [] }],
      [IpcChannels.versionsRemove, { id: '00000000-0000-4000-8000-000000000000' }],
      [IpcChannels.presetsSave, { projectId: null, name: '', settings: {} }],
      [IpcChannels.presetsList, {}],
      [IpcChannels.youtubeCredentialsSet, { clientId: 'not-a-google-id', clientSecret: '' }],
      [IpcChannels.accountsAddManual, { platformId: 'myspace', displayName: 'x', projectIds: [] }],
      [IpcChannels.accountsAddManual, { platformId: 'tiktok', displayName: '', projectIds: [] }],
      [IpcChannels.platformsOpenUpload, { platformId: 'tiktok', url: 'https://evil.example' }],
      [IpcChannels.publicationsCreate, { versionId: '00000000-0000-4000-8000-000000000000', destinations: [], requestId: '00000000-0000-4000-8000-000000000000' }],
      [IpcChannels.publicationsCreate, { versionId: '00000000-0000-4000-8000-000000000000', destinations: [{ accountId: 'x', title: null, caption: null, hashtags: [], fields: {} }], requestId: '00000000-0000-4000-8000-000000000000' }],
      [IpcChannels.publicationsMarkPublished, { id: '00000000-0000-4000-8000-000000000000', url: 'javascript:alert(1)' }]
    ]
    for (const [channel, input] of cases) {
      const result = await ctx.call(channel, input)
      expect(result.ok, `${channel} should reject ${JSON.stringify(input)}`).toBe(false)
      expect(!result.ok && result.error.code).toBe('VALIDATION')
    }
    const listed = await ctx.call<Project[]>(IpcChannels.projectsList)
    expect(listed.ok && listed.data).toEqual([])
  })

  it('hides internal error details from the renderer but logs them', async () => {
    const result = await ctx.call(IpcChannels.appGetInfo)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INTERNAL')
    expect(result.error.message).not.toContain('internal detail')
    const logged = ctx.logger.entries.find((e) => e.level === 'error')
    expect((logged?.context?.error as Error).message).toBe('internal detail that must not leak')
  })

  it('reports unavailable FFmpeg with its actionable message', async () => {
    const result = await ctx.call(IpcChannels.mediaImportPaths, { paths: ['/music/take.mp4'] })
    expect(result).toEqual({
      ok: false,
      error: { code: 'UNAVAILABLE', message: 'FFmpeg is missing from this installation. Reinstall Social Machine.' }
    })
  })

  it('lists an empty media library and idle queue', async () => {
    expect(await ctx.call(IpcChannels.mediaList)).toEqual({ ok: true, data: [] })
    expect(await ctx.call(IpcChannels.mediaQueueState)).toEqual({
      ok: true,
      data: { active: false, total: 0, completed: 0, failed: 0, current: [] }
    })
    const missing = await ctx.call(IpcChannels.mediaRemove, { id: '00000000-0000-4000-8000-000000000000' })
    expect(!missing.ok && missing.error.code).toBe('NOT_FOUND')
  })

  it('creates the suggested projects and assigns contents to them in bulk', async () => {
    const created = await ctx.call<Project[]>(IpcChannels.projectsCreateSuggested)
    expect(created.ok && created.data.map((p) => p.name)).toEqual(['MMA', 'Futebol', 'Basquete', 'Skate'])
    if (!created.ok) return
    const mma = created.data[0]!

    const a = ctx.mediaRepo.insertPending({ path: '/v/a.mp4', pathKey: '/v/a.mp4', size: 1, mtimeMs: 1 })!
    const b = ctx.mediaRepo.insertPending({ path: '/v/b.mp4', pathKey: '/v/b.mp4', size: 1, mtimeMs: 1 })!
    const moved = await ctx.call<ContentItem[]>(IpcChannels.mediaSetProject, { ids: [a.id, b.id], projectId: mma.id })
    expect(moved.ok && moved.data.every((c) => c.projectId === mma.id)).toBe(true)
    const marked = await ctx.call<ContentItem[]>(IpcChannels.mediaSetWorkflowStatus, { ids: [a.id], workflowStatus: 'ready' })
    expect(marked.ok && marked.data[0]!.workflowStatus).toBe('ready')
    // Changes are pushed to the renderer, so every open view updates.
    expect(ctx.events).toContainEqual({ type: 'asset', asset: expect.objectContaining({ id: a.id, workflowStatus: 'ready' }) })

    const unknown = await ctx.call(IpcChannels.mediaSetProject, { ids: [a.id], projectId: '00000000-0000-4000-8000-000000000000' })
    expect(!unknown.ok && unknown.error.code).toBe('NOT_FOUND')
  })

  it('updates and removes watched folders, refreshing the watcher', async () => {
    const folder = ctx.watchRepo.add({ path: '/nonexistent/output', pathKey: '/nonexistent/output', origin: 'drop_machine', projectId: null })
    await ctx.watchService.refresh()

    const paused = await ctx.call<WatchFolderStatus>(IpcChannels.watchUpdate, { id: folder.id, enabled: false })
    expect(paused.ok && paused.data).toMatchObject({ id: folder.id, enabled: false, state: 'disabled' })

    const listed = await ctx.call<WatchFolderStatus[]>(IpcChannels.watchList)
    expect(listed.ok && listed.data).toHaveLength(1)

    expect(await ctx.call(IpcChannels.watchRemove, { id: folder.id })).toEqual({ ok: true, data: null })
    const empty = await ctx.call<WatchFolderStatus[]>(IpcChannels.watchList)
    expect(empty.ok && empty.data).toEqual([])
    ctx.watchService.stop()
  })

  it('saves and lists editing presets, and reports the encoder', async () => {
    const settings = { version: 1, output: { preset: '9:16' }, frame: { fit: 'cover', zoom: 1, x: 0, y: 0, background: 'blur' }, texts: [], audio: { mute: false } }
    const saved = await ctx.call<{ id: string; name: string }>(IpcChannels.presetsSave, { projectId: null, name: 'Limpo', settings })
    expect(saved.ok && saved.data.name).toBe('Limpo')
    const listed = await ctx.call<{ name: string }[]>(IpcChannels.presetsList, { projectId: null })
    expect(listed.ok && listed.data.map((p) => p.name)).toEqual(['Limpo'])
    expect(await ctx.call(IpcChannels.editorEncoder)).toMatchObject({ ok: true, data: { id: 'libopenh264' } })
    expect(await ctx.call(IpcChannels.versionsCounts)).toEqual({ ok: true, data: {} })
  })

  it('manages manual accounts and YouTube credentials, never returning the secret', async () => {
    const platforms = await ctx.call<{ id: string; configured: boolean; capabilities: string[] }[]>(IpcChannels.platformsList)
    expect(platforms.ok && platforms.data.map((p) => [p.id, p.configured, p.capabilities[0]])).toEqual([
      ['youtube', false, 'publish'],
      ['tiktok', true, 'manual'],
      ['instagram', true, 'manual']
    ])
    expect(await ctx.call(IpcChannels.youtubeCredentialsSet, { clientId: '1-a.apps.googleusercontent.com', clientSecret: 'GOCSPX-x' })).toEqual({ ok: true, data: null })
    const creds = await ctx.call(IpcChannels.youtubeCredentialsGet)
    expect(creds).toEqual({ ok: true, data: { clientId: '1-a.apps.googleusercontent.com' } })
    expect(JSON.stringify(creds)).not.toContain('GOCSPX')

    const added = await ctx.call<{ id: string; manual: boolean }>(IpcChannels.accountsAddManual, { platformId: 'tiktok', displayName: '@cortes', projectIds: [] })
    expect(added.ok && added.data.manual).toBe(true)
    expect(await ctx.call(IpcChannels.platformsOpenUpload, { platformId: 'tiktok' })).toEqual({ ok: true, data: null })
    expect(ctx.opened).toEqual(['https://www.tiktok.com/upload'])
    if (added.ok) expect(await ctx.call(IpcChannels.accountsRemove, { id: added.data.id })).toEqual({ ok: true, data: null })
  })

  it('updates settings through the allowed keys only', async () => {
    const result = await ctx.call(IpcChannels.settingsUpdate, { accentColor: '#4c9be8' })
    expect(result.ok && (result.data as { accentColor: string }).accentColor).toBe('#4c9be8')
  })

  it('forwards renderer log messages', async () => {
    await ctx.call(IpcChannels.logWrite, { level: 'warn', message: 'from renderer', context: { x: 1 } })
    expect(ctx.logger.entries).toContainEqual({ level: 'warn', message: 'from renderer', context: { x: 1 } })
  })
})

describe('sender validation', () => {
  const indexPath = join(process.cwd(), 'out', 'renderer', 'index.html')

  it('accepts the bundled renderer page', () => {
    const isTrusted = createSenderValidator({ rendererIndexPath: indexPath })
    const url = pathToFileURL(indexPath).href
    expect(isTrusted(url)).toBe(true)
    expect(isTrusted(url + '#/songs')).toBe(true)
  })

  it('rejects other pages', () => {
    const isTrusted = createSenderValidator({ rendererIndexPath: indexPath })
    expect(isTrusted('https://example.com/')).toBe(false)
    expect(isTrusted('file:///C:/somewhere/else.html')).toBe(false)
    expect(isTrusted('')).toBe(false)
    expect(isTrusted(undefined)).toBe(false)
    expect(isTrusted('not a url')).toBe(false)
  })

  it('accepts the dev server only when configured', () => {
    const dev = createSenderValidator({ devServerUrl: 'http://localhost:5173', rendererIndexPath: indexPath })
    expect(dev('http://localhost:5173/')).toBe(true)
    expect(dev('http://localhost:5174/')).toBe(false)
    const prod = createSenderValidator({ rendererIndexPath: indexPath })
    expect(prod('http://localhost:5173/')).toBe(false)
  })
})

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, session, shell, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { IpcEvents } from '../shared/channels'
import type { MediaEvent } from '../shared/media'
import type { WatchEvent, WatchFolderStatus, WatchOrigin } from '../shared/watch'
import type { SqlDriver } from './db/driver'
import { createBetterSqliteDriver } from './db/better-sqlite3-driver'
import { openDatabase } from './db/open'
import { NotFoundError } from './errors'
import { buildHandlers } from './ipc/handlers'
import { registerIpcHandlers } from './ipc/register'
import { createLogger, type Logger } from './logger'
import { resolveMediaTools } from './media/binaries'
import { cleanTempDirectory, pathKey, VIDEO_EXTENSIONS } from './media/files'
import { ImportService } from './media/import-service'
import { handleMediaRequest, MEDIA_SCHEME, MEDIA_SCHEME_PRIVILEGES } from './media/protocol'
import { MediaToolsManager } from './media/tools-manager'
import { ensureLayout, resolveLayout, resolveRootDirectory, writeBootstrap, type AppLayout } from './paths'
import { ContentsRepository } from './repositories/contents'
import { ProjectsRepository } from './repositories/projects'
import { SettingsRepository } from './repositories/settings'
import { WatchFoldersRepository } from './repositories/watch-folders'
import { createSenderValidator } from './security'
import { TRAY_ICON_16, TRAY_ICON_32 } from './tray-icon'
import { WatchService } from './watch/watch-service'

const APP_NAME = 'Social Machine'
const isDev = !app.isPackaged
const devServerUrl = process.env['ELECTRON_RENDERER_URL']
const rendererIndexPath = join(__dirname, '../renderer/index.html')
const preloadPath = join(__dirname, '../preload/index.js')
const bootstrapFile = join(app.getPath('userData'), 'bootstrap.json')
/** Passed when Windows starts the app at login: start in the tray without a window. */
const HIDDEN_FLAG = '--hidden'
/** Tests and portable setups can turn the tray off; closing the window then quits. */
const trayDisabled = process.env['SM_DISABLE_TRAY'] === '1'

// Must happen before the app is ready.
protocol.registerSchemesAsPrivileged([MEDIA_SCHEME_PRIVILEGES])

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let db: SqlDriver | null = null
let logger: Logger | null = null
let importService: ImportService | null = null
let watchService: WatchService | null = null
let settingsRepo: SettingsRepository | null = null
let quitting = false
let trayHintShown = false

if (!app.requestSingleInstanceLock()) {
  // Another instance already runs (and watches the folders). Bring it forward instead.
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(start).catch(fatal)
}

function start(): void {
  const { root, overridden } = resolveRootDirectory({
    env: process.env,
    bootstrapFile,
    documentsDirectory: app.getPath('documents')
  })
  const layout = resolveLayout(root)
  ensureLayout(layout)

  logger = createLogger({ directory: layout.logs, mirrorToConsole: isDev, minLevel: isDev ? 'debug' : 'info' })
  const log = logger
  log.info('App starting', { version: app.getVersion(), root, overridden, electron: process.versions.electron })

  process.on('uncaughtException', (error) => log.error('Uncaught exception', { error }))
  process.on('unhandledRejection', (reason) => log.error('Unhandled promise rejection', { reason }))

  const opened = openDatabase({
    databasePath: layout.database,
    backupsDirectory: layout.backups,
    createDriver: createBetterSqliteDriver,
    logger: log.child('db')
  })
  db = opened.db

  const projects = new ProjectsRepository(opened.db)
  const settings = new SettingsRepository(opened.db, log.child('settings'))
  settingsRepo = settings
  const contents = new ContentsRepository(opened.db)
  const watchFolders = new WatchFoldersRepository(opened.db)

  // ---- Media -----------------------------------------------------------
  const toolsLocation = resolveMediaTools({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    platform: process.platform,
    arch: process.arch,
    env: process.env
  })
  const tools = new MediaToolsManager(toolsLocation, log.child('ffmpeg'))
  void tools.status() // verify in the background right away

  void cleanTempDirectory(layout.temp).then((removed) => {
    if (removed) log.info('Removed leftover temporary files', { removed })
  })

  const service = new ImportService({
    repo: contents,
    getTools: () => tools.require(),
    thumbnailsDirectory: layout.thumbnails,
    tempDirectory: layout.temp,
    logger: log.child('media'),
    emit: sendMediaEvent
  })
  importService = service

  // ---- Folder watching ---------------------------------------------------
  const watcher = new WatchService({
    folders: watchFolders,
    knownFiles: () => contents.knownFiles(),
    importer: (paths, options) => service.importPaths(paths, options),
    logger: log.child('watch'),
    emit: (folders) => {
      sendWatchEvent({ type: 'folders', folders })
      updateTrayTooltip(folders)
    },
    scanIntervalMs: () => settings.get().watchScanIntervalSeconds * 1000
  })
  watchService = watcher

  protocol.handle(MEDIA_SCHEME, (request) =>
    handleMediaRequest(request, { repo: contents, thumbnailsDirectory: layout.thumbnails })
  )

  hardenSessions()

  const handlers = buildHandlers({
    projects,
    settings,
    logger: log.child('ipc'),
    rendererLogger: log.child('renderer'),
    getAppInfo: () => ({
      version: app.getVersion(),
      rootDirectory: layout.root,
      appDataDirectory: layout.appData,
      databasePath: layout.database,
      logsDirectory: layout.logs,
      exportDirectory: settings.get().exportDirectory ?? layout.defaultExports,
      schemaVersion: opened.schemaVersion,
      rootDirectoryOverridden: overridden,
      trayAvailable: tray !== null
    }),
    openLogsFolder: async () => {
      const error = await shell.openPath(layout.logs)
      if (error) throw new Error(`Não foi possível abrir a pasta de logs: ${error}`)
    },
    chooseDataDirectory: () => chooseDataDirectory(layout),
    chooseExportDirectory: async () => {
      const path = await pickFolder('Escolha a pasta de exportação')
      if (!path) return { changed: false }
      settings.update({ exportDirectory: path })
      log.info('Export folder changed', { path })
      return { changed: true, path, restartRequired: false }
    },
    media: {
      repo: contents,
      service,
      toolsStatus: () => tools.status(),
      recheckTools: async () => {
        const status = await tools.recheck()
        // Files skipped while FFmpeg was missing are picked up again.
        if (status.ok) void watcher.scanNow()
        return status
      },
      importWithDialog: async (mode, projectId) => {
        // Check first, so the user isn't asked to pick files that can't be imported.
        await tools.require()
        const paths = await pickVideos(mode)
        if (!paths) return { cancelled: true }
        return { cancelled: false, ...(await service.importPaths(paths, { projectId, origin: 'manual' })) }
      },
      relinkWithDialog: async (id) => {
        const asset = contents.get(id)
        const folder = dirname(asset.sourcePath)
        const result = await showOpenDialog({
          title: `Localizar “${asset.fileName}”`,
          defaultPath: existsSync(folder) ? folder : undefined,
          properties: ['openFile'],
          filters: videoFilters()
        })
        if (result.canceled || !result.filePaths[0]) return { status: 'cancelled' }
        return service.relink(id, result.filePaths[0])
      },
      relinkFolderWithDialog: async () => {
        const folder = await pickFolder('Escolha uma pasta para procurar os arquivos ausentes')
        if (!folder) return { cancelled: true }
        return service.relinkFromFolder(folder)
      },
      showInFolder: (id) => {
        const asset = contents.get(id)
        if (existsSync(asset.sourcePath)) {
          shell.showItemInFolder(asset.sourcePath)
        } else if (existsSync(dirname(asset.sourcePath))) {
          void shell.openPath(dirname(asset.sourcePath))
        } else {
          throw new NotFoundError(`Nem “${asset.fileName}” nem a pasta dele existem mais. Use “Localizar” para encontrá-lo.`)
        }
      }
    },
    watch: {
      repo: watchFolders,
      service: watcher,
      addWithDialog: async (origin: WatchOrigin, projectId: string | null) => {
        const path = await pickFolder(
          origin === 'drop_machine' ? 'Escolha a pasta de saída da Drop Machine' : 'Escolha uma pasta para monitorar'
        )
        if (!path) return { cancelled: true }
        const record = watchFolders.add({ path, pathKey: pathKey(path), origin, projectId })
        log.info('Watch folder added', { path, origin, projectId })
        await watcher.refresh()
        const status = watcher.status().find((f) => f.id === record.id)
        if (!status) throw new NotFoundError('A pasta foi removida enquanto era adicionada.')
        return { cancelled: false, folder: status }
      },
      openFolder: async (path) => {
        const error = await shell.openPath(path)
        if (error) throw new NotFoundError(`Não foi possível abrir a pasta: ${error}`)
      }
    },
    onSettingsChanged: () => applyOsSettings()
  })

  registerIpcHandlers(
    ipcMain,
    handlers,
    createSenderValidator({ devServerUrl: isDev ? devServerUrl : undefined, rendererIndexPath }),
    log.child('ipc')
  )

  createTray()
  applyOsSettings()

  const startHidden = process.argv.includes(HIDDEN_FLAG) && tray !== null
  createWindow(!startHidden)
  if (startHidden) log.info('Started hidden in the tray (launched at login)')

  service.start()
  // Reconciliation: files created while the app was closed are found here.
  void watcher.start().catch((error) => log.error('Folder watching failed to start', { error }))

  app.on('activate', () => showWindow())
}

/* ---------------------------------------------------------------------- */
/* Tray and OS integration                                                */
/* ---------------------------------------------------------------------- */

function createTray(): void {
  if (trayDisabled) return
  try {
    const image = nativeImage.createFromDataURL(TRAY_ICON_16)
    image.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_32 })
    tray = new Tray(image)
    tray.setToolTip(APP_NAME)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Abrir ${APP_NAME}`, click: () => showWindow() },
        {
          label: 'Verificar pastas agora',
          click: () => void watchService?.scanNow().catch((error) => logger?.warn('Manual scan failed', { error }))
        },
        { type: 'separator' },
        { label: 'Sair (para de monitorar as pastas)', click: () => quitApp() }
      ])
    )
    tray.on('click', () => showWindow())
    tray.on('double-click', () => showWindow())
  } catch (error) {
    // Without a tray, closing the window quits the app (watching stops until the next start).
    tray = null
    logger?.warn('System tray unavailable; closing the window will quit the app', { error })
  }
}

function updateTrayTooltip(folders: WatchFolderStatus[]): void {
  if (!tray) return
  const active = folders.filter((f) => f.state === 'watching' || f.state === 'polling').length
  const waiting = folders.reduce((sum, f) => sum + f.waitingFiles, 0)
  const parts = [APP_NAME]
  if (active) parts.push(`monitorando ${active} pasta${active === 1 ? '' : 's'}`)
  if (waiting) parts.push(`${waiting} arquivo${waiting === 1 ? '' : 's'} aguardando`)
  tray.setToolTip(parts.join(' · '))
}

/** Settings that live in the OS: start with Windows (hidden in the tray). */
function applyOsSettings(): void {
  if (!settingsRepo || process.platform === 'linux') return
  // In development the executable is electron.exe; registering it would start a bare Electron at login.
  if (isDev) return
  const { launchAtLogin } = settingsRepo.get()
  try {
    app.setLoginItemSettings({ openAtLogin: launchAtLogin, args: [HIDDEN_FLAG] })
  } catch (error) {
    logger?.warn('Could not update launch-at-login setting', { error })
  }
}

function quitApp(): void {
  quitting = true
  app.quit()
}

/* ---------------------------------------------------------------------- */
/* Dialogs                                                                */
/* ---------------------------------------------------------------------- */

function videoFilters(): Electron.FileFilter[] {
  return [
    { name: 'Vídeos', extensions: [...VIDEO_EXTENSIONS] },
    { name: 'Todos os arquivos', extensions: ['*'] }
  ]
}

function showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options)
}

async function pickVideos(mode: 'files' | 'folder'): Promise<string[] | null> {
  const result = await showOpenDialog(
    mode === 'files'
      ? { title: 'Importar vídeos', properties: ['openFile', 'multiSelections'], filters: videoFilters() }
      : { title: 'Importar uma pasta de vídeos', properties: ['openDirectory', 'multiSelections'] }
  )
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths
}

async function chooseDataDirectory(current: AppLayout) {
  const path = await pickFolder('Escolha onde a Social Machine guarda os dados')
  if (!path || path === current.root) return { changed: false } as const
  writeBootstrap(bootstrapFile, { rootDirectory: path })
  logger?.info('Data folder changed (takes effect after restart)', { from: current.root, to: path })
  return { changed: true, path, restartRequired: true } as const
}

async function pickFolder(title: string): Promise<string | null> {
  const result = await showOpenDialog({ title, properties: ['openDirectory', 'createDirectory'] })
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
}

/* ---------------------------------------------------------------------- */
/* Window                                                                 */
/* ---------------------------------------------------------------------- */

function sendMediaEvent(event: MediaEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IpcEvents.media, event)
}

function sendWatchEvent(event: WatchEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IpcEvents.watch, event)
}

let lastAvailabilityCheck = 0
function checkAvailabilitySoon(): void {
  // Files may have been moved while the app was in the background.
  if (!importService || Date.now() - lastAvailabilityCheck < 15_000) return
  lastAvailabilityCheck = Date.now()
  void importService.checkAvailability().catch((error) => logger?.warn('Availability check failed', { error }))
}

function showWindow(): void {
  if (!app.isReady()) return
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(true)
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createWindow(show: boolean): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0e1014',
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  if (show) mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  // Closing the window keeps watching in the tray, unless the user is quitting or turned it off.
  mainWindow.on('close', (event) => {
    if (quitting || !tray || !settingsRepo?.get().minimizeToTray) return
    event.preventDefault()
    mainWindow?.hide()
    if (!trayHintShown && process.platform === 'win32') {
      trayHintShown = true
      tray.displayBalloon({
        title: APP_NAME,
        content: 'Continua monitorando as pastas na área de notificação. Para sair de vez, use “Sair” no ícone.'
      })
    }
  })
  mainWindow.on('focus', checkAvailabilitySoon)
  mainWindow.webContents.on('did-finish-load', checkAvailabilitySoon)

  // No popups, no navigation away from the app. External http(s) links open in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Also covers files dropped outside the drop zone, which would otherwise open as a page.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev && devServerUrl && url.startsWith(devServerUrl)
    if (!allowed) {
      event.preventDefault()
      logger?.warn('Blocked navigation', { url })
    }
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger?.error('Renderer process gone', { ...details })
  })

  if (isDev && devServerUrl) {
    void mainWindow.loadURL(devServerUrl)
  } else {
    void mainWindow.loadFile(rendererIndexPath)
  }
}

function hardenSessions(): void {
  // The app needs no camera, microphone, notifications or geolocation.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
}

function fatal(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  logger?.error('Fatal startup error', { error })
  const logHint = logger ? `\n\nArquivo de log: ${logger.filePath}` : ''
  dialog.showErrorBox('A Social Machine não conseguiu iniciar', `${message}${logHint}`)
  app.exit(1)
}

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  // With the tray enabled the window is only hidden (see the 'close' handler) and this doesn't fire.
  // Reaching here means there is no tray or the user turned "minimize to tray" off: quit.
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  try {
    watchService?.stop()
    // Stop FFmpeg child processes; unfinished imports resume on the next start.
    importService?.shutdown()
    tray?.destroy()
    db?.close()
    logger?.info('App closed')
  } catch (error) {
    logger?.error('Error while closing database', { error })
  }
})

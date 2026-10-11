import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { SmApi } from '../shared/api'
import { IpcChannels, IpcEvents, type IpcChannel } from '../shared/channels'
import type { MediaEvent } from '../shared/media'
import type { WatchEvent } from '../shared/watch'
import type { VersionEvent } from '../shared/editor'
import type { PublicationEvent } from '../shared/publishing'
import type { IpcResult } from '../shared/schemas'

/**
 * The renderer gets exactly these functions and nothing else: no ipcRenderer,
 * no generic invoke, no Node APIs. Inputs are validated again in main.
 */
const call = <T>(channel: IpcChannel, input?: unknown): Promise<IpcResult<T>> =>
  ipcRenderer.invoke(channel, input) as Promise<IpcResult<T>>

const api: SmApi = {
  app: {
    getInfo: () => call(IpcChannels.appGetInfo),
    openLogsFolder: () => call(IpcChannels.appOpenLogsFolder),
    copyText: (text) => call(IpcChannels.appCopyText, { text })
  },
  projects: {
    list: () => call(IpcChannels.projectsList),
    get: (id) => call(IpcChannels.projectsGet, { id }),
    create: (input) => call(IpcChannels.projectsCreate, input),
    update: (input) => call(IpcChannels.projectsUpdate, input),
    delete: (id) => call(IpcChannels.projectsDelete, { id }),
    createSuggested: () => call(IpcChannels.projectsCreateSuggested)
  },
  media: {
    toolsStatus: () => call(IpcChannels.mediaToolsStatus),
    recheckTools: () => call(IpcChannels.mediaToolsRecheck),
    list: () => call(IpcChannels.mediaList),
    queueState: () => call(IpcChannels.mediaQueueState),
    importWithDialog: (mode, projectId) => call(IpcChannels.mediaImportDialog, { mode, projectId: projectId ?? null }),
    importDropped: (files, projectId) => {
      // Real paths are only obtainable from genuine File objects (drag-and-drop or <input>),
      // so the renderer can't hand arbitrary path strings to the main process.
      const paths = Array.from(files)
        .map((file) => webUtils.getPathForFile(file))
        .filter((path) => path.length > 0)
      if (paths.length === 0) {
        return Promise.resolve({
          ok: false,
          error: { code: 'VALIDATION', message: 'Nada que possa ser importado foi solto. Arraste arquivos ou pastas do seu computador.' }
        })
      }
      return call(IpcChannels.mediaImportPaths, { paths, projectId: projectId ?? null })
    },
    cancel: (id) => call(IpcChannels.mediaCancel, { id }),
    cancelAll: () => call(IpcChannels.mediaCancelAll),
    retry: (id) => call(IpcChannels.mediaRetry, { id }),
    remove: (id) => call(IpcChannels.mediaRemove, { id }),
    relink: (id) => call(IpcChannels.mediaRelink, { id }),
    relinkConfirm: (id) => call(IpcChannels.mediaRelinkConfirm, { id }),
    relinkFolder: () => call(IpcChannels.mediaRelinkFolder),
    checkAvailability: () => call(IpcChannels.mediaCheckAvailability),
    showInFolder: (id) => call(IpcChannels.mediaShowInFolder, { id }),
    stats: () => call(IpcChannels.mediaStats),
    setWorkflowStatus: (ids, workflowStatus) => call(IpcChannels.mediaSetWorkflowStatus, { ids, workflowStatus }),
    setProject: (ids, projectId) => call(IpcChannels.mediaSetProject, { ids, projectId }),
    setTitle: (id, title) => call(IpcChannels.mediaSetTitle, { id, title }),
    onEvent: (listener) => {
      // Only the payload is forwarded; the IpcRendererEvent (with its sender) never reaches the page.
      const handler = (_event: Electron.IpcRendererEvent, payload: MediaEvent) => listener(payload)
      ipcRenderer.on(IpcEvents.media, handler)
      return () => {
        ipcRenderer.removeListener(IpcEvents.media, handler)
      }
    }
  },
  watch: {
    list: () => call(IpcChannels.watchList),
    add: (origin, projectId) => call(IpcChannels.watchAdd, { origin, projectId: projectId ?? null }),
    update: (input) => call(IpcChannels.watchUpdate, input),
    remove: (id) => call(IpcChannels.watchRemove, { id }),
    scanNow: (id) => call(IpcChannels.watchScanNow, id ? { id } : {}),
    openFolder: (id) => call(IpcChannels.watchOpenFolder, { id }),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: WatchEvent) => listener(payload)
      ipcRenderer.on(IpcEvents.watch, handler)
      return () => {
        ipcRenderer.removeListener(IpcEvents.watch, handler)
      }
    }
  },
  versions: {
    list: (contentId) => call(IpcChannels.versionsList, { contentId }),
    create: (input) => call(IpcChannels.versionsCreate, input),
    retry: (id) => call(IpcChannels.versionsRetry, { id }),
    cancel: (id) => call(IpcChannels.versionsCancel, { id }),
    remove: (id, deleteFile) => call(IpcChannels.versionsRemove, { id, deleteFile }),
    showInFolder: (id) => call(IpcChannels.versionsShowInFolder, { id }),
    counts: () => call(IpcChannels.versionsCounts),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: VersionEvent) => listener(payload)
      ipcRenderer.on(IpcEvents.versions, handler)
      return () => {
        ipcRenderer.removeListener(IpcEvents.versions, handler)
      }
    }
  },
  presets: {
    list: (projectId) => call(IpcChannels.presetsList, { projectId }),
    save: (input) => call(IpcChannels.presetsSave, input),
    delete: (id) => call(IpcChannels.presetsDelete, { id })
  },
  editor: {
    encoder: () => call(IpcChannels.editorEncoder)
  },
  platforms: {
    list: () => call(IpcChannels.platformsList),
    openUpload: (platformId) => call(IpcChannels.platformsOpenUpload, { platformId })
  },
  youtube: {
    credentials: () => call(IpcChannels.youtubeCredentialsGet),
    setCredentials: (clientId, clientSecret) => call(IpcChannels.youtubeCredentialsSet, { clientId, clientSecret }),
    clearCredentials: () => call(IpcChannels.youtubeCredentialsClear)
  },
  accounts: {
    list: () => call(IpcChannels.accountsList),
    connectYouTube: (projectIds) => call(IpcChannels.accountsConnectYouTube, { projectIds }),
    addManual: (platformId, displayName, projectIds) => call(IpcChannels.accountsAddManual, { platformId, displayName, projectIds }),
    update: (id, patch) => call(IpcChannels.accountsUpdate, { id, ...patch }),
    disconnect: (id) => call(IpcChannels.accountsDisconnect, { id }),
    remove: (id) => call(IpcChannels.accountsRemove, { id })
  },
  publications: {
    list: (filter) => call(IpcChannels.publicationsList, filter ?? {}),
    create: (input) => call(IpcChannels.publicationsCreate, input),
    retry: (id) => call(IpcChannels.publicationsRetry, { id }),
    cancel: (id) => call(IpcChannels.publicationsCancel, { id }),
    markPublished: (id, url) => call(IpcChannels.publicationsMarkPublished, { id, url }),
    openUrl: (id) => call(IpcChannels.publicationsOpenUrl, { id }),
    notes: (versionId) => call(IpcChannels.publicationsNotes, { id: versionId }),
    queue: (from, to) => call(IpcChannels.publicationsQueue, { from, to }),
    reschedule: (id, scheduledAt) => call(IpcChannels.publicationsReschedule, { id, scheduledAt }),
    publishNow: (id) => call(IpcChannels.publicationsPublishNow, { id }),
    pause: (id) => call(IpcChannels.publicationsPause, { id }),
    resume: (id) => call(IpcChannels.publicationsResume, { id }),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: PublicationEvent) => listener(payload)
      ipcRenderer.on(IpcEvents.publishing, handler)
      return () => {
        ipcRenderer.removeListener(IpcEvents.publishing, handler)
      }
    }
  },
  queue: {
    settings: () => call(IpcChannels.queueSettingsList),
    saveSettings: (settings) => call(IpcChannels.queueSettingsSave, settings),
    nextSlots: (accountId, count, after) =>
      call(IpcChannels.queueNextSlots, after ? { accountId, count: count ?? 1, after } : { accountId, count: count ?? 1 })
  },
  analytics: {
    overview: () => call(IpcChannels.analyticsOverview),
    content: (contentId) => call(IpcChannels.analyticsContent, { contentId }),
    refresh: (accountId) => call(IpcChannels.analyticsRefresh, accountId ? { accountId } : {}),
    addManual: (input) => call(IpcChannels.analyticsAddManual, input),
    deleteManual: (id) => call(IpcChannels.analyticsDeleteManual, { id }),
    onEvent: (listener) => {
      const handler = () => listener()
      ipcRenderer.on(IpcEvents.analytics, handler)
      return () => {
        ipcRenderer.removeListener(IpcEvents.analytics, handler)
      }
    }
  },
  settings: {
    get: () => call(IpcChannels.settingsGet),
    update: (input) => call(IpcChannels.settingsUpdate, input),
    chooseDataDirectory: () => call(IpcChannels.settingsChooseDataDirectory),
    chooseExportDirectory: () => call(IpcChannels.settingsChooseExportDirectory)
  },
  log: {
    write: (input) => call(IpcChannels.logWrite, input)
  }
}

contextBridge.exposeInMainWorld('sm', api)

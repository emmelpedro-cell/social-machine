import type {
  AppInfo,
  CreateProjectInput,
  DirectoryChoiceResult,
  IpcResult,
  LogWriteInput,
  Project,
  ProjectSummary,
  Settings,
  SettingsUpdateInput,
  UpdateProjectInput
} from './schemas'
import type {
  ContentVersion,
  EditPreset,
  EncoderInfo,
  RenderVersionInput,
  SavePresetInput,
  VersionEvent
} from './editor'
import type {
  Account,
  CreatePublicationsInput,
  CreatePublicationsResult,
  PlatformId,
  PlatformInfo,
  Publication,
  PublicationEvent,
  PublicationSummary,
  QueueItem,
  QueueSettings
} from './publishing'
import type {
  AddWatchFolderResult,
  UpdateWatchFolderInput,
  WatchEvent,
  WatchFolderStatus,
  WatchOrigin
} from './watch'
import type {
  ImportDialogResult,
  ImportQueueState,
  ImportSummary,
  ContentItem,
  LibraryStats,
  WorkflowStatus,
  MediaEvent,
  MediaToolsStatus,
  RelinkFolderResult,
  RelinkResult
} from './media'

/** The API exposed to the renderer as `window.sm`. Every call is validated in the main process. */
export interface SmApi {
  app: {
    getInfo(): Promise<IpcResult<AppInfo>>
    openLogsFolder(): Promise<IpcResult<null>>
    copyText(text: string): Promise<IpcResult<null>>
  }
  projects: {
    list(): Promise<IpcResult<ProjectSummary[]>>
    get(id: string): Promise<IpcResult<Project>>
    create(input: CreateProjectInput): Promise<IpcResult<Project>>
    update(input: UpdateProjectInput): Promise<IpcResult<Project>>
    /** Contents of a deleted project stay in the library without a project. */
    delete(id: string): Promise<IpcResult<null>>
    /** Creates MMA, Futebol, Basquete and Skate (existing names are skipped). */
    createSuggested(): Promise<IpcResult<Project[]>>
  }
  media: {
    toolsStatus(): Promise<IpcResult<MediaToolsStatus>>
    recheckTools(): Promise<IpcResult<MediaToolsStatus>>
    list(): Promise<IpcResult<ContentItem[]>>
    queueState(): Promise<IpcResult<ImportQueueState>>
    /** Opens the system file or folder picker and imports the selection into a project (or none). */
    importWithDialog(mode: 'files' | 'folder', projectId?: string | null): Promise<IpcResult<ImportDialogResult>>
    /** Imports files or folders dropped onto the window. */
    importDropped(files: readonly File[], projectId?: string | null): Promise<IpcResult<ImportSummary>>
    cancel(id: string): Promise<IpcResult<null>>
    cancelAll(): Promise<IpcResult<null>>
    retry(id: string): Promise<IpcResult<ContentItem>>
    remove(id: string): Promise<IpcResult<null>>
    /** Opens a file picker to locate a moved file. */
    relink(id: string): Promise<IpcResult<RelinkResult>>
    /** Confirms a relink whose file content differs from the original. */
    relinkConfirm(id: string): Promise<IpcResult<RelinkResult>>
    /** Opens a folder picker and relinks every missing file found inside it. */
    relinkFolder(): Promise<IpcResult<RelinkFolderResult>>
    checkAvailability(): Promise<IpcResult<{ missing: number }>>
    showInFolder(id: string): Promise<IpcResult<null>>
    stats(): Promise<IpcResult<LibraryStats>>
    setWorkflowStatus(ids: string[], workflowStatus: WorkflowStatus): Promise<IpcResult<ContentItem[]>>
    setProject(ids: string[], projectId: string | null): Promise<IpcResult<ContentItem[]>>
    setTitle(id: string, title: string | null): Promise<IpcResult<ContentItem>>
    /** Subscribes to library changes. Returns an unsubscribe function. */
    onEvent(listener: (event: MediaEvent) => void): () => void
  }
  watch: {
    list(): Promise<IpcResult<WatchFolderStatus[]>>
    /** Opens a folder picker and starts watching the chosen folder. */
    add(origin: WatchOrigin, projectId?: string | null): Promise<IpcResult<AddWatchFolderResult>>
    update(input: UpdateWatchFolderInput): Promise<IpcResult<WatchFolderStatus>>
    /** Stops watching. Already imported contents stay; the folder's files are never touched. */
    remove(id: string): Promise<IpcResult<null>>
    scanNow(id?: string): Promise<IpcResult<WatchFolderStatus[]>>
    openFolder(id: string): Promise<IpcResult<null>>
    onEvent(listener: (event: WatchEvent) => void): () => void
  }
  versions: {
    list(contentId: string): Promise<IpcResult<ContentVersion[]>>
    /** Queues a render. Text overlays are PNGs drawn by the editor at output size. */
    create(input: RenderVersionInput): Promise<IpcResult<ContentVersion>>
    retry(id: string): Promise<IpcResult<ContentVersion>>
    cancel(id: string): Promise<IpcResult<null>>
    /** Deletes a version; its exported file only when deleteFile is true. */
    remove(id: string, deleteFile: boolean): Promise<IpcResult<null>>
    showInFolder(id: string): Promise<IpcResult<null>>
    /** Number of versions per content id. */
    counts(): Promise<IpcResult<Record<string, number>>>
    onEvent(listener: (event: VersionEvent) => void): () => void
  }
  presets: {
    list(projectId: string | null): Promise<IpcResult<EditPreset[]>>
    save(input: SavePresetInput): Promise<IpcResult<EditPreset>>
    delete(id: string): Promise<IpcResult<null>>
  }
  editor: {
    /** The H.264 encoder exports will use on this machine. */
    encoder(): Promise<IpcResult<EncoderInfo>>
  }
  platforms: {
    list(): Promise<IpcResult<PlatformInfo[]>>
    /** Opens the platform's own upload page in the browser (manual publishing). */
    openUpload(platformId: PlatformId): Promise<IpcResult<null>>
  }
  youtube: {
    /** The configured client ID (the secret is never sent to the renderer). */
    credentials(): Promise<IpcResult<{ clientId: string | null }>>
    setCredentials(clientId: string, clientSecret: string): Promise<IpcResult<null>>
    clearCredentials(): Promise<IpcResult<null>>
  }
  accounts: {
    list(): Promise<IpcResult<Account[]>>
    /** Opens Google's consent page in the browser and waits for the user to approve. */
    connectYouTube(projectIds: string[]): Promise<IpcResult<Account>>
    addManual(platformId: PlatformId, displayName: string, projectIds: string[]): Promise<IpcResult<Account>>
    update(id: string, patch: { displayName?: string; projectIds?: string[] }): Promise<IpcResult<Account>>
    disconnect(id: string): Promise<IpcResult<Account>>
    remove(id: string): Promise<IpcResult<null>>
  }
  publications: {
    list(filter?: { contentId?: string; limit?: number }): Promise<IpcResult<PublicationSummary[]>>
    create(input: CreatePublicationsInput): Promise<IpcResult<CreatePublicationsResult>>
    retry(id: string): Promise<IpcResult<Publication>>
    cancel(id: string): Promise<IpcResult<Publication>>
    markPublished(id: string, url: string): Promise<IpcResult<Publication>>
    openUrl(id: string): Promise<IpcResult<null>>
    /** Remarks per platform for a version (e.g. "will be a Short"). */
    notes(versionId: string): Promise<IpcResult<Record<PlatformId, string[]>>>
    onEvent(listener: (event: PublicationEvent) => void): () => void
    /** Publications planned in a range plus everything waiting for the user. */
    queue(from: string, to: string): Promise<IpcResult<QueueItem[]>>
    reschedule(id: string, scheduledAt: string): Promise<IpcResult<Publication>>
    publishNow(id: string): Promise<IpcResult<Publication>>
    pause(id: string): Promise<IpcResult<Publication>>
    resume(id: string): Promise<IpcResult<Publication>>
  }
  queue: {
    /** Posting preferences of every account. */
    settings(): Promise<IpcResult<QueueSettings[]>>
    saveSettings(settings: QueueSettings): Promise<IpcResult<QueueSettings>>
    /** Next free posting slots of an account (ISO times). */
    nextSlots(accountId: string, count?: number, after?: string): Promise<IpcResult<string[]>>
  }
  settings: {
    get(): Promise<IpcResult<Settings>>
    update(input: SettingsUpdateInput): Promise<IpcResult<Settings>>
    chooseDataDirectory(): Promise<IpcResult<DirectoryChoiceResult>>
    chooseExportDirectory(): Promise<IpcResult<DirectoryChoiceResult>>
  }
  log: {
    write(input: LogWriteInput): Promise<IpcResult<null>>
  }
}

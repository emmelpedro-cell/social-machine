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

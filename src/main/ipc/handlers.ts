import { z } from 'zod'
import { IpcChannels, type IpcChannel } from '../../shared/channels'
import {
  AssetIdInputSchema,
  ImportDialogInputSchema,
  ImportPathsInputSchema,
  SetContentProjectInputSchema,
  SetContentTitleInputSchema,
  SetWorkflowStatusInputSchema,
  type ImportDialogResult,
  type MediaToolsStatus,
  type RelinkFolderResult,
  type RelinkResult
} from '../../shared/media'
import {
  CreateProjectInputSchema,
  EmptyInputSchema,
  LogWriteInputSchema,
  ProjectIdInputSchema,
  SettingsUpdateInputSchema,
  SUGGESTED_PROJECTS,
  UpdateProjectInputSchema,
  type AppInfo,
  type DirectoryChoiceResult
} from '../../shared/schemas'
import {
  AddWatchFolderInputSchema,
  UpdateWatchFolderInputSchema,
  WatchFolderIdInputSchema,
  type AddWatchFolderResult,
  type WatchOrigin
} from '../../shared/watch'
import {
  ContentIdInputSchema,
  PresetIdInputSchema,
  RenderVersionInputSchema,
  SavePresetInputSchema,
  VersionIdInputSchema,
  type EncoderInfo
} from '../../shared/editor'
import { NotFoundError } from '../errors'
import type { RenderService } from '../editor/render-service'
import {
  AccountIdInputSchema,
  AddManualAccountInputSchema,
  ConnectYouTubeInputSchema,
  CreatePublicationsInputSchema,
  MarkPublishedInputSchema,
  NextSlotsInputSchema,
  PublicationIdInputSchema,
  QueueRangeInputSchema,
  QueueSettingsInputSchema,
  RescheduleInputSchema,
  type Weekday,
  PublicationListInputSchema,
  UpdateAccountInputSchema,
  YouTubeCredentialsInputSchema,
  type Account,
  type PlatformId
} from '../../shared/publishing'
import type { AccountsRepository } from '../repositories/accounts'
import type { PublicationsRepository } from '../repositories/publications'
import type { PublishService } from '../publishing/publish-service'
import type { QueueSettingsRepository } from '../repositories/queue-settings'
import type { MetricsService } from '../analytics/metrics-service'
import {
  ContentAnalyticsInputSchema,
  ManualMetricsInputSchema,
  RefreshMetricsInputSchema,
  SnapshotIdInputSchema
} from '../../shared/analytics'
import { nextFreeSlots } from '../../shared/schedule'
import type { YouTubeClientConfig } from '../connectors/config'
import type { PresetsRepository } from '../repositories/presets'
import type { VersionsRepository } from '../repositories/versions'
import type { Logger } from '../logger'
import type { ImportService } from '../media/import-service'
import type { ContentsRepository } from '../repositories/contents'
import type { ProjectsRepository } from '../repositories/projects'
import type { SettingsRepository } from '../repositories/settings'
import type { WatchFoldersRepository } from '../repositories/watch-folders'
import type { WatchService } from '../watch/watch-service'
import { defineHandler, type HandlerDefinition } from './handler'

/** Everything the handlers need from the outside world, so they can be tested without Electron. */
export type HandlerDeps = {
  projects: ProjectsRepository
  settings: SettingsRepository
  logger: Logger
  rendererLogger: Logger
  getAppInfo: () => AppInfo
  openLogsFolder: () => Promise<void>
  copyText?: (text: string) => void
  chooseDataDirectory: () => Promise<DirectoryChoiceResult>
  chooseExportDirectory: () => Promise<DirectoryChoiceResult>
  media: {
    repo: ContentsRepository
    service: ImportService
    toolsStatus: () => Promise<MediaToolsStatus>
    recheckTools: () => Promise<MediaToolsStatus>
    /** Native dialogs and shell integration live in main/index.ts. */
    importWithDialog: (mode: 'files' | 'folder', projectId: string | null) => Promise<ImportDialogResult>
    relinkWithDialog: (id: string) => Promise<RelinkResult>
    relinkFolderWithDialog: () => Promise<RelinkFolderResult>
    showInFolder: (id: string) => void
  }
  watch: {
    repo: WatchFoldersRepository
    service: WatchService
    /** Shows a folder picker and adds the folder. */
    addWithDialog: (origin: WatchOrigin, projectId: string | null) => Promise<AddWatchFolderResult>
    openFolder: (path: string) => Promise<void>
  }
  editor: {
    versions: VersionsRepository
    presets: PresetsRepository
    renderer: RenderService
    encoder: () => Promise<EncoderInfo>
    showVersionInFolder: (path: string) => void
  }
  publishing: {
    accounts: AccountsRepository
    publications: PublicationsRepository
    service: PublishService
    queueSettings: QueueSettingsRepository
    youtubeConfig: YouTubeClientConfig
    connectYouTube: (projectIds: string[]) => Promise<Account>
    disconnect: (id: string) => Promise<Account>
    remove: (id: string) => void
    /** Opens an https URL in the system browser. */
    openExternal: (url: string) => Promise<void>
  }
  analytics: MetricsService
  onSettingsChanged?: () => void
}

// Input/output types are enforced per entry by defineHandler; the table itself is heterogeneous.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HandlerTable = Record<IpcChannel, HandlerDefinition<any, any>>

export function buildHandlers(deps: HandlerDeps): HandlerTable {
  const { media, watch, editor, publishing } = deps
  const assertProjects = (ids: readonly string[] | undefined) => {
    for (const id of ids ?? []) assertProject(id)
  }
  const assertProject = (projectId: string | null | undefined) => {
    if (projectId && !deps.projects.exists(projectId)) {
      throw new NotFoundError('Esse projeto não existe mais. Escolha outro.')
    }
  }
  const watchStatus = (id: string) => {
    const status = watch.service.status().find((f) => f.id === id)
    if (!status) throw new NotFoundError('Essa pasta monitorada não existe mais.')
    return status
  }
  return {
    [IpcChannels.appGetInfo]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => deps.getAppInfo()
    }),
    [IpcChannels.appOpenLogsFolder]: defineHandler({
      schema: EmptyInputSchema,
      handle: async () => {
        await deps.openLogsFolder()
        return null
      }
    }),

    [IpcChannels.appCopyText]: defineHandler({
      schema: z.object({ text: z.string().max(20_000) }).strict(),
      handle: ({ text }) => {
        deps.copyText?.(text)
        return null
      }
    }),

    [IpcChannels.projectsList]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => deps.projects.list()
    }),
    [IpcChannels.projectsGet]: defineHandler({
      schema: ProjectIdInputSchema,
      handle: ({ id }) => deps.projects.get(id)
    }),
    [IpcChannels.projectsCreate]: defineHandler({
      schema: CreateProjectInputSchema,
      handle: (input) => {
        const project = deps.projects.create(input)
        deps.logger.info('Project created', { id: project.id })
        return project
      }
    }),
    [IpcChannels.projectsUpdate]: defineHandler({
      schema: UpdateProjectInputSchema,
      handle: (input) => deps.projects.update(input)
    }),
    [IpcChannels.projectsCreateSuggested]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => {
        const created = deps.projects.createMany(SUGGESTED_PROJECTS.map((p) => ({ ...p, description: null })))
        deps.logger.info('Suggested projects created', { count: created.length })
        return created
      }
    }),
    [IpcChannels.projectsDelete]: defineHandler({
      schema: ProjectIdInputSchema,
      handle: ({ id }) => {
        deps.projects.delete(id)
        deps.logger.info('Project deleted', { id })
        return null
      }
    }),

    [IpcChannels.mediaToolsStatus]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => media.toolsStatus()
    }),
    [IpcChannels.mediaToolsRecheck]: defineHandler({
      schema: EmptyInputSchema,
      handle: async () => {
        const status = await media.recheckTools()
        if (status.ok) media.service.resume()
        return status
      }
    }),
    [IpcChannels.mediaList]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => media.repo.list()
    }),
    [IpcChannels.mediaQueueState]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => media.service.queueState()
    }),
    [IpcChannels.mediaImportDialog]: defineHandler({
      schema: ImportDialogInputSchema,
      handle: ({ mode, projectId }) => {
        assertProject(projectId)
        return media.importWithDialog(mode, projectId ?? null)
      }
    }),
    [IpcChannels.mediaImportPaths]: defineHandler({
      schema: ImportPathsInputSchema,
      handle: ({ paths, projectId }) => {
        assertProject(projectId)
        return media.service.importPaths(paths, { projectId: projectId ?? null, origin: 'manual' })
      }
    }),
    [IpcChannels.mediaCancel]: defineHandler({
      schema: AssetIdInputSchema,
      handle: async ({ id }) => {
        await media.service.cancel(id)
        return null
      }
    }),
    [IpcChannels.mediaCancelAll]: defineHandler({
      schema: EmptyInputSchema,
      handle: async () => {
        await media.service.cancelAll()
        return null
      }
    }),
    [IpcChannels.mediaRetry]: defineHandler({
      schema: AssetIdInputSchema,
      handle: ({ id }) => media.service.retry(id)
    }),
    [IpcChannels.mediaRemove]: defineHandler({
      schema: AssetIdInputSchema,
      handle: async ({ id }) => {
        await media.service.remove(id)
        return null
      }
    }),
    [IpcChannels.mediaRelink]: defineHandler({
      schema: AssetIdInputSchema,
      handle: ({ id }) => media.relinkWithDialog(id)
    }),
    [IpcChannels.mediaRelinkConfirm]: defineHandler({
      schema: AssetIdInputSchema,
      handle: ({ id }) => media.service.confirmRelink(id)
    }),
    [IpcChannels.mediaRelinkFolder]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => media.relinkFolderWithDialog()
    }),
    [IpcChannels.mediaCheckAvailability]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => media.service.checkAvailability()
    }),
    [IpcChannels.mediaShowInFolder]: defineHandler({
      schema: AssetIdInputSchema,
      handle: ({ id }) => {
        media.showInFolder(id)
        return null
      }
    }),

    [IpcChannels.mediaStats]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => media.repo.stats()
    }),
    [IpcChannels.mediaSetWorkflowStatus]: defineHandler({
      schema: SetWorkflowStatusInputSchema,
      handle: ({ ids, workflowStatus }) => {
        const updated = media.repo.setWorkflowStatus(ids, workflowStatus)
        media.service.announce(updated)
        return updated
      }
    }),
    [IpcChannels.mediaSetProject]: defineHandler({
      schema: SetContentProjectInputSchema,
      handle: ({ ids, projectId }) => {
        assertProject(projectId)
        const updated = media.repo.setProject(ids, projectId)
        media.service.announce(updated)
        return updated
      }
    }),
    [IpcChannels.mediaSetTitle]: defineHandler({
      schema: SetContentTitleInputSchema,
      handle: ({ id, title }) => {
        const updated = media.repo.setTitle(id, title)
        media.service.announce([updated])
        return updated
      }
    }),

    [IpcChannels.watchList]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => watch.service.status()
    }),
    [IpcChannels.watchAdd]: defineHandler({
      schema: AddWatchFolderInputSchema,
      handle: ({ origin, projectId }) => {
        assertProject(projectId)
        return watch.addWithDialog(origin, projectId ?? null)
      }
    }),
    [IpcChannels.watchUpdate]: defineHandler({
      schema: UpdateWatchFolderInputSchema,
      handle: async ({ id, ...patch }) => {
        assertProject(patch.projectId)
        watch.repo.update(id, patch)
        await watch.service.refresh()
        deps.logger.info('Watch folder updated', { id, ...patch })
        return watchStatus(id)
      }
    }),
    [IpcChannels.watchRemove]: defineHandler({
      schema: WatchFolderIdInputSchema,
      handle: async ({ id }) => {
        watch.repo.remove(id)
        await watch.service.refresh()
        deps.logger.info('Watch folder removed', { id })
        return null
      }
    }),
    [IpcChannels.watchScanNow]: defineHandler({
      schema: z.union([EmptyInputSchema, WatchFolderIdInputSchema]),
      handle: async (input) => {
        const id = input && 'id' in input ? input.id : undefined
        if (id) watch.repo.get(id)
        await watch.service.scanNow(id)
        return watch.service.status()
      }
    }),
    [IpcChannels.watchOpenFolder]: defineHandler({
      schema: WatchFolderIdInputSchema,
      handle: async ({ id }) => {
        await watch.openFolder(watch.repo.get(id).path)
        return null
      }
    }),

    [IpcChannels.versionsList]: defineHandler({
      schema: ContentIdInputSchema,
      handle: ({ contentId }) => editor.versions.listForContent(contentId)
    }),
    [IpcChannels.versionsCreate]: defineHandler({
      schema: RenderVersionInputSchema,
      handle: (input) => editor.renderer.create(input)
    }),
    [IpcChannels.versionsRetry]: defineHandler({
      schema: VersionIdInputSchema,
      handle: ({ id }) => editor.renderer.retry(id)
    }),
    [IpcChannels.versionsCancel]: defineHandler({
      schema: VersionIdInputSchema,
      handle: async ({ id }) => {
        await editor.renderer.cancel(id)
        return null
      }
    }),
    [IpcChannels.versionsRemove]: defineHandler({
      schema: z.object({ id: z.string().uuid('Versão inválida'), deleteFile: z.boolean() }).strict(),
      handle: async ({ id, deleteFile }) => {
        await editor.renderer.remove(id, deleteFile)
        return null
      }
    }),
    [IpcChannels.versionsShowInFolder]: defineHandler({
      schema: VersionIdInputSchema,
      handle: ({ id }) => {
        const version = editor.versions.get(id)
        if (!version.filePath) throw new NotFoundError('Essa versão não tem arquivo.')
        editor.showVersionInFolder(version.filePath)
        return null
      }
    }),
    [IpcChannels.versionsCounts]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => Object.fromEntries(editor.versions.countsByContent())
    }),
    [IpcChannels.presetsList]: defineHandler({
      schema: z.object({ projectId: z.string().uuid('Projeto inválido').nullable() }).strict(),
      handle: ({ projectId }) => editor.presets.list(projectId)
    }),
    [IpcChannels.presetsSave]: defineHandler({
      schema: SavePresetInputSchema,
      handle: (input) => {
        assertProject(input.projectId)
        return editor.presets.save(input)
      }
    }),
    [IpcChannels.presetsDelete]: defineHandler({
      schema: PresetIdInputSchema,
      handle: ({ id }) => {
        editor.presets.delete(id)
        return null
      }
    }),
    [IpcChannels.editorEncoder]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => editor.encoder()
    }),

    [IpcChannels.platformsList]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => publishing.service.platforms()
    }),
    [IpcChannels.platformsOpenUpload]: defineHandler({
      schema: z.object({ platformId: z.enum(['youtube', 'tiktok', 'instagram']) }).strict(),
      handle: async ({ platformId }) => {
        const info = publishing.service.platforms().find((p) => p.id === (platformId as PlatformId))
        if (!info?.uploadUrl) throw new NotFoundError('Essa plataforma não tem uma página de envio conhecida.')
        await publishing.openExternal(info.uploadUrl)
        return null
      }
    }),
    [IpcChannels.youtubeCredentialsGet]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => ({ clientId: publishing.youtubeConfig.clientId() })
    }),
    [IpcChannels.youtubeCredentialsSet]: defineHandler({
      schema: YouTubeCredentialsInputSchema,
      handle: ({ clientId, clientSecret }) => {
        publishing.youtubeConfig.set({ clientId, clientSecret })
        deps.logger.info('YouTube client credentials saved', { clientId })
        return null
      }
    }),
    [IpcChannels.youtubeCredentialsClear]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => {
        publishing.youtubeConfig.clear()
        return null
      }
    }),
    [IpcChannels.accountsList]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => publishing.accounts.list()
    }),
    [IpcChannels.accountsConnectYouTube]: defineHandler({
      schema: ConnectYouTubeInputSchema,
      handle: ({ projectIds }) => {
        assertProjects(projectIds)
        return publishing.connectYouTube(projectIds)
      }
    }),
    [IpcChannels.accountsAddManual]: defineHandler({
      schema: AddManualAccountInputSchema,
      handle: ({ platformId, displayName, projectIds }) => {
        assertProjects(projectIds)
        return publishing.accounts.addManual({ platformId, displayName, projectIds })
      }
    }),
    [IpcChannels.accountsUpdate]: defineHandler({
      schema: UpdateAccountInputSchema,
      handle: ({ id, ...patch }) => {
        assertProjects(patch.projectIds)
        return publishing.accounts.update(id, patch)
      }
    }),
    [IpcChannels.accountsDisconnect]: defineHandler({
      schema: AccountIdInputSchema,
      handle: ({ id }) => publishing.disconnect(id)
    }),
    [IpcChannels.accountsRemove]: defineHandler({
      schema: AccountIdInputSchema,
      handle: ({ id }) => {
        publishing.remove(id)
        return null
      }
    }),
    [IpcChannels.publicationsList]: defineHandler({
      schema: PublicationListInputSchema,
      handle: (filter) => publishing.publications.list(filter)
    }),
    [IpcChannels.publicationsCreate]: defineHandler({
      schema: CreatePublicationsInputSchema,
      handle: (input) => publishing.service.create(input)
    }),
    [IpcChannels.publicationsRetry]: defineHandler({
      schema: PublicationIdInputSchema,
      handle: ({ id }) => publishing.service.retry(id)
    }),
    [IpcChannels.publicationsCancel]: defineHandler({
      schema: PublicationIdInputSchema,
      handle: ({ id }) => publishing.service.cancel(id)
    }),
    [IpcChannels.publicationsMarkPublished]: defineHandler({
      schema: MarkPublishedInputSchema,
      handle: ({ id, url }) => publishing.service.markManualPublished(id, url)
    }),
    [IpcChannels.publicationsOpenUrl]: defineHandler({
      schema: PublicationIdInputSchema,
      handle: async ({ id }) => {
        const url = publishing.publications.get(id).externalUrl
        if (!url || !/^https:\/\//.test(url)) throw new NotFoundError('Essa publicação não tem um link.')
        await publishing.openExternal(url)
        return null
      }
    }),
    [IpcChannels.publicationsNotes]: defineHandler({
      schema: VersionIdInputSchema,
      handle: ({ id }) => publishing.service.notes(id)
    }),
    [IpcChannels.publicationsQueue]: defineHandler({
      schema: QueueRangeInputSchema,
      handle: (range) =>
        publishing.publications.listQueue({ from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() })
    }),
    [IpcChannels.publicationsReschedule]: defineHandler({
      schema: RescheduleInputSchema,
      handle: ({ id, scheduledAt }) => publishing.service.reschedule(id, scheduledAt)
    }),
    [IpcChannels.publicationsPublishNow]: defineHandler({
      schema: PublicationIdInputSchema,
      handle: ({ id }) => publishing.service.publishNow(id)
    }),
    [IpcChannels.publicationsPause]: defineHandler({
      schema: PublicationIdInputSchema,
      handle: ({ id }) => publishing.service.pause(id)
    }),
    [IpcChannels.publicationsResume]: defineHandler({
      schema: PublicationIdInputSchema,
      handle: ({ id }) => publishing.service.resume(id)
    }),
    [IpcChannels.queueSettingsList]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => publishing.queueSettings.all(publishing.accounts.list().map((a) => a.id))
    }),
    [IpcChannels.queueSettingsSave]: defineHandler({
      schema: QueueSettingsInputSchema,
      handle: (input) => {
        publishing.accounts.get(input.accountId) // must exist
        return publishing.queueSettings.save({ ...input, days: input.days as Weekday[] })
      }
    }),
    [IpcChannels.queueNextSlots]: defineHandler({
      schema: NextSlotsInputSchema,
      handle: ({ accountId, count, after }) => {
        publishing.accounts.get(accountId)
        const start = after ? new Date(after) : new Date()
        const occupied = publishing.publications.plannedTimes(accountId, new Date(start.getTime() - 3_600_000).toISOString())
        return nextFreeSlots(publishing.queueSettings.get(accountId), occupied, start, count).map((d) => d.toISOString())
      }
    }),

    [IpcChannels.analyticsOverview]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => deps.analytics.overview()
    }),
    [IpcChannels.analyticsContent]: defineHandler({
      schema: ContentAnalyticsInputSchema,
      handle: ({ contentId }) => deps.analytics.content(contentId)
    }),
    [IpcChannels.analyticsRefresh]: defineHandler({
      schema: RefreshMetricsInputSchema,
      handle: ({ accountId }) => deps.analytics.refresh(accountId)
    }),
    [IpcChannels.analyticsAddManual]: defineHandler({
      schema: ManualMetricsInputSchema,
      handle: (input) => deps.analytics.addManual(input)
    }),
    [IpcChannels.analyticsDeleteManual]: defineHandler({
      schema: SnapshotIdInputSchema,
      handle: ({ id }) => {
        deps.analytics.deleteManual(id)
        return null
      }
    }),

    [IpcChannels.settingsGet]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => deps.settings.get()
    }),
    [IpcChannels.settingsUpdate]: defineHandler({
      schema: SettingsUpdateInputSchema,
      handle: (patch) => {
        const updated = deps.settings.update(patch)
        deps.onSettingsChanged?.()
        return updated
      }
    }),
    [IpcChannels.settingsChooseDataDirectory]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => deps.chooseDataDirectory()
    }),
    [IpcChannels.settingsChooseExportDirectory]: defineHandler({
      schema: EmptyInputSchema,
      handle: () => deps.chooseExportDirectory()
    }),

    [IpcChannels.logWrite]: defineHandler({
      schema: LogWriteInputSchema,
      handle: ({ level, message, context }) => {
        deps.rendererLogger[level](message, context)
        return null
      }
    })
  }
}

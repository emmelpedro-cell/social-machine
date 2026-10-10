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
import { NotFoundError } from '../errors'
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
  onSettingsChanged?: () => void
}

// Input/output types are enforced per entry by defineHandler; the table itself is heterogeneous.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HandlerTable = Record<IpcChannel, HandlerDefinition<any, any>>

export function buildHandlers(deps: HandlerDeps): HandlerTable {
  const { media, watch } = deps
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

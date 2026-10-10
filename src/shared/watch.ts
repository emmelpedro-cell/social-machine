import { z } from 'zod'

/** How a watched folder is labelled and where its contents come from. */
export type WatchOrigin = 'watch_folder' | 'drop_machine'

/** Runtime state of a watched folder. */
export type WatchState =
  /** File-system events are active, plus periodic rescans. */
  | 'watching'
  /** Events could not be attached; new files are still found by periodic rescans. */
  | 'polling'
  /** The folder doesn't exist or can't be read right now. Retried on every rescan. */
  | 'unavailable'
  | 'disabled'

export type WatchFolder = {
  id: string
  path: string
  label: string | null
  origin: WatchOrigin
  projectId: string | null
  enabled: boolean
  lastScanAt: string | null
  lastError: string | null
  createdAt: string
}

export type WatchFolderStatus = WatchFolder & {
  state: WatchState
  /** Files seen but not yet stable (still being written). */
  waitingFiles: number
}

export const WatchFolderIdInputSchema = z.object({ id: z.string().uuid('Pasta inválida') }).strict()

export const AddWatchFolderInputSchema = z
  .object({
    origin: z.enum(['watch_folder', 'drop_machine']),
    projectId: z.string().uuid('Projeto inválido').nullable().optional()
  })
  .strict()

export const UpdateWatchFolderInputSchema = z
  .object({
    id: z.string().uuid('Pasta inválida'),
    label: z
      .string()
      .trim()
      .max(80)
      .nullable()
      .optional()
      .transform((v) => (v === '' ? null : v)),
    origin: z.enum(['watch_folder', 'drop_machine']).optional(),
    projectId: z.string().uuid('Projeto inválido').nullable().optional(),
    enabled: z.boolean().optional()
  })
  .strict()
export type UpdateWatchFolderInput = z.input<typeof UpdateWatchFolderInputSchema>

export type AddWatchFolderResult =
  | { cancelled: true }
  | { cancelled: false; folder: WatchFolderStatus }

/** Pushed to the renderer when folder status changes. */
export type WatchEvent = { type: 'folders'; folders: WatchFolderStatus[] }

/** Suggested default for the Drop Machine output folder (Windows). */
export const DROP_MACHINE_DEFAULT_OUTPUT = 'C:\\drop-machine\\public\\output'

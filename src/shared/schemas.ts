import { z } from 'zod'

/* ------------------------------------------------------------------ */
/* Content projects                                                   */
/* ------------------------------------------------------------------ */

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

const name = z
  .string()
  .trim()
  .min(1, 'O nome é obrigatório')
  .max(80, 'O nome pode ter no máximo 80 caracteres')

const optionalText = (max: number, label: string) =>
  z.string().trim().max(max, `${label} pode ter no máximo ${max} caracteres`)

export const ProjectIdSchema = z.string().uuid('Projeto inválido')

/** Per-project preferences (spec §3). Later phases add keys; unknown keys are kept. */
export const ProjectSettingsSchema = z
  .object({
    defaultHashtags: z.array(z.string().trim().min(1).max(100)).max(60).default([]),
    captionTemplate: z.string().max(5000).default('')
  })
  .passthrough()
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>

export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  color: z.string(),
  settings: ProjectSettingsSchema,
  createdAt: z.string(),
  updatedAt: z.string()
})
export type Project = z.infer<typeof ProjectSchema>

/** Project with library counts, for lists and the dashboard. */
export type ProjectSummary = Project & {
  contentCount: number
  needsReviewCount: number
  readyCount: number
}

const emptyToNull = (v: string | null | undefined) => (v ? v : null)

export const CreateProjectInputSchema = z
  .object({
    name,
    description: optionalText(2000, 'A descrição').nullable().optional().transform(emptyToNull),
    category: optionalText(80, 'A categoria').nullable().optional().transform(emptyToNull),
    color: z.string().regex(HEX_COLOR, 'Cor inválida').optional()
  })
  .strict()
export type CreateProjectInput = z.input<typeof CreateProjectInputSchema>
export type CreateProjectData = z.output<typeof CreateProjectInputSchema>

export const UpdateProjectInputSchema = z
  .object({
    id: ProjectIdSchema,
    name: name.optional(),
    description: optionalText(2000, 'A descrição')
      .nullable()
      .optional()
      .transform((v) => (v === '' ? null : v)),
    category: optionalText(80, 'A categoria')
      .nullable()
      .optional()
      .transform((v) => (v === '' ? null : v)),
    color: z.string().regex(HEX_COLOR, 'Cor inválida').optional(),
    settings: ProjectSettingsSchema.optional()
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'id' && v[k as keyof typeof v] !== undefined), {
    message: 'Nada para atualizar'
  })
export type UpdateProjectInput = z.input<typeof UpdateProjectInputSchema>
export type UpdateProjectData = z.output<typeof UpdateProjectInputSchema>

export const ProjectIdInputSchema = z.object({ id: ProjectIdSchema }).strict()
export type ProjectIdInput = z.infer<typeof ProjectIdInputSchema>

/** Starter projects offered on an empty install (spec §3). Created only when the user asks. */
export const SUGGESTED_PROJECTS: readonly { name: string; category: string; color: string }[] = [
  { name: 'MMA', category: 'Esporte', color: '#e5484d' },
  { name: 'Futebol', category: 'Esporte', color: '#30a46c' },
  { name: 'Basquete', category: 'Esporte', color: '#f76b15' },
  { name: 'Skate', category: 'Esporte', color: '#8e4ec6' }
]

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS = {
  accentColor: '#3d8bfd',
  exportDirectory: null as string | null,
  /** Closing the window keeps the app (and folder watching) running in the tray. */
  minimizeToTray: true,
  /** Start with Windows, hidden in the tray. */
  launchAtLogin: false,
  /** Full rescan of watched folders, as a safety net for missed file-system events. */
  watchScanIntervalSeconds: 60,
  /** 'auto' uses a hardware H.264 encoder when one works; 'software' always uses OpenH264. */
  encoderPreference: 'auto' as 'auto' | 'software'
}

export const SettingsSchema = z.object({
  accentColor: z.string().regex(HEX_COLOR, 'A cor deve estar no formato #RRGGBB'),
  exportDirectory: z.string().min(1).nullable(),
  minimizeToTray: z.boolean(),
  launchAtLogin: z.boolean(),
  watchScanIntervalSeconds: z.number().int().min(15).max(3600),
  encoderPreference: z.enum(['auto', 'software'])
})
export type Settings = z.infer<typeof SettingsSchema>

/** Only these keys may be changed from the renderer. Directories go through native dialogs. */
export const SettingsUpdateInputSchema = z
  .object({
    accentColor: SettingsSchema.shape.accentColor.optional(),
    minimizeToTray: SettingsSchema.shape.minimizeToTray.optional(),
    launchAtLogin: SettingsSchema.shape.launchAtLogin.optional(),
    watchScanIntervalSeconds: SettingsSchema.shape.watchScanIntervalSeconds.optional(),
    encoderPreference: SettingsSchema.shape.encoderPreference.optional()
  })
  .strict()
export type SettingsUpdateInput = z.infer<typeof SettingsUpdateInputSchema>

/* ------------------------------------------------------------------ */
/* App info, logging, IPC envelope                                    */
/* ------------------------------------------------------------------ */

export type AppInfo = {
  version: string
  rootDirectory: string
  appDataDirectory: string
  databasePath: string
  logsDirectory: string
  exportDirectory: string
  schemaVersion: number
  rootDirectoryOverridden: boolean
  /** False when the system tray could not be created (closing the window then quits). */
  trayAvailable: boolean
}

export type DirectoryChoiceResult =
  | { changed: false }
  | { changed: true; path: string; restartRequired: boolean }

export const LogWriteInputSchema = z
  .object({
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string().min(1).max(4000),
    context: z.record(z.unknown()).optional()
  })
  .strict()
export type LogWriteInput = z.infer<typeof LogWriteInputSchema>

/** No input expected. Accepts undefined or an empty object, nothing else. */
export const EmptyInputSchema = z.union([z.undefined(), z.object({}).strict()])

export type IpcErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNAVAILABLE'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'INTERNAL'

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: IpcErrorCode; message: string } }

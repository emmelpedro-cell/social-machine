import { z } from 'zod'

/* ------------------------------------------------------------------ */
/* Media tools (FFmpeg / FFprobe)                                     */
/* ------------------------------------------------------------------ */

export type MediaToolsSource = 'packaged' | 'development' | 'environment'

export type MediaToolsStatus =
  | {
      ok: true
      source: MediaToolsSource
      directory: string
      ffmpegVersion: string
      ffprobeVersion: string
      /** From the bundled manifest, when present. */
      license: string | null
      build: string | null
    }
  | {
      ok: false
      source: MediaToolsSource
      directory: string
      code: 'MISSING' | 'FAILED'
      /** Actionable, user-facing. */
      message: string
      /** Technical detail for the log / diagnostics panel. */
      detail: string
    }

/* ------------------------------------------------------------------ */
/* Assets                                                             */
/* ------------------------------------------------------------------ */

export type MediaKind = 'audio' | 'video'
export type MediaStatus = 'pending' | 'processing' | 'ready' | 'error'
export type MediaAvailability = 'online' | 'missing'

/** Where a content came from. */
export type ContentOrigin = 'manual' | 'watch_folder' | 'drop_machine'
export const CONTENT_ORIGINS: readonly ContentOrigin[] = ['manual', 'watch_folder', 'drop_machine']

/** The user's editorial state, independent of processing status and file availability. */
export type WorkflowStatus = 'imported' | 'needs_review' | 'editing' | 'ready' | 'archived'
export const WORKFLOW_STATUSES: readonly WorkflowStatus[] = ['imported', 'needs_review', 'editing', 'ready', 'archived']

export const WORKFLOW_LABELS: Record<WorkflowStatus, string> = {
  imported: 'Importado',
  needs_review: 'Precisa de revisão',
  editing: 'Em edição',
  ready: 'Pronto',
  archived: 'Arquivado'
}

/**
 * What the library shows: the editorial state, except that a content with at
 * least one publication out is "Publicado" (unless archived). Derived from the
 * publications, so it never disagrees with them.
 */
export type EditorialState = WorkflowStatus | 'published'

export const EDITORIAL_LABELS: Record<EditorialState, string> = { ...WORKFLOW_LABELS, published: 'Publicado' }

export function editorialState(asset: Pick<ContentItem, 'workflowStatus' | 'publishedCount'>): EditorialState {
  return asset.publishedCount > 0 && asset.workflowStatus !== 'archived' ? 'published' : asset.workflowStatus
}

export const ORIGIN_LABELS: Record<ContentOrigin, string> = {
  manual: 'Importação manual',
  watch_folder: 'Pasta monitorada',
  drop_machine: 'Drop Machine'
}

/** Options attached to an import request. */
export type ImportOptions = {
  projectId?: string | null
  origin?: ContentOrigin
  watchFolderId?: string | null
  workflowStatus?: WorkflowStatus
}

export type ContentItem = {
  id: string
  projectId: string | null
  title: string | null
  origin: ContentOrigin
  watchFolderId: string | null
  workflowStatus: WorkflowStatus
  /** Publications of this content that are out (any version, any destination). */
  publishedCount: number
  lastPublishedAt: string | null
  fileName: string
  sourcePath: string
  fileSize: number
  /** Null until probed. */
  kind: MediaKind | null
  status: MediaStatus
  errorMessage: string | null
  availability: MediaAvailability
  durationSeconds: number | null
  container: string | null
  videoCodec: string | null
  audioCodec: string | null
  /** Display size, i.e. after applying rotation metadata. */
  width: number | null
  height: number | null
  frameRate: number | null
  rotation: number | null
  sampleRate: number | null
  channels: number | null
  bitRate: number | null
  hasThumbnail: boolean
  importedAt: string
  updatedAt: string
}

export type ImportQueueState = {
  /** True while anything is queued or processing. */
  active: boolean
  /** Counters for the current batch; reset when the queue becomes idle. */
  total: number
  completed: number
  failed: number
  /** File names being processed right now. */
  current: string[]
}

export type ImportSummary = {
  queued: number
  alreadyInLibrary: number
  /** Files skipped while scanning folders because their extension isn't a media type. */
  skippedNonMedia: number
  /** Folder scan hit the file limit; some files were not considered. */
  truncated: boolean
  errors: { path: string; message: string }[]
}

export type ImportDialogResult = { cancelled: true } | ({ cancelled: false } & ImportSummary)

export type RelinkResult =
  | { status: 'cancelled' }
  | { status: 'relinked'; asset: ContentItem; reprocessing: boolean }
  /** The chosen file's content differs from the original; confirm with relinkConfirm. */
  | { status: 'mismatch'; fileName: string }

export type RelinkFolderResult =
  | { cancelled: true }
  | { cancelled: false; relinked: number; stillMissing: number; scannedFiles: number }

export type MediaEvent =
  | { type: 'asset'; asset: ContentItem }
  | { type: 'removed'; id: string }
  | { type: 'queue'; state: ImportQueueState }
  /** A file was not added because the same content is already in the library. */
  | { type: 'duplicate'; fileName: string; existingFileName: string }

/* ------------------------------------------------------------------ */
/* IPC inputs                                                         */
/* ------------------------------------------------------------------ */

export const AssetIdInputSchema = z.object({ id: z.string().uuid('Invalid asset id') }).strict()

const optionalProjectId = z.string().uuid('Projeto inválido').nullable().optional()

export const ImportDialogInputSchema = z
  .object({ mode: z.enum(['files', 'folder']), projectId: optionalProjectId })
  .strict()

/**
 * Paths come only from the preload script, which derives them from dropped
 * File objects with webUtils.getPathForFile. They are still validated here.
 */
export const ImportPathsInputSchema = z
  .object({
    paths: z
      .array(z.string().min(1).max(32_767))
      .min(1, 'Nothing to import')
      .max(2000, 'Too many items at once (maximum 2000)'),
    projectId: optionalProjectId
  })
  .strict()
export type ImportPathsInput = z.infer<typeof ImportPathsInputSchema>

const contentIds = z.array(z.string().uuid('Conteúdo inválido')).min(1).max(5000)

export const SetWorkflowStatusInputSchema = z
  .object({ ids: contentIds, workflowStatus: z.enum(['imported', 'needs_review', 'editing', 'ready', 'archived']) })
  .strict()

export const SetContentProjectInputSchema = z
  .object({ ids: contentIds, projectId: z.string().uuid('Projeto inválido').nullable() })
  .strict()

export const SetContentTitleInputSchema = z
  .object({
    id: z.string().uuid('Conteúdo inválido'),
    title: z
      .string()
      .trim()
      .max(200, 'O título pode ter no máximo 200 caracteres')
      .nullable()
      .transform((v) => (v ? v : null))
  })
  .strict()

/** Library counts for the dashboard. */
export type LibraryStats = {
  total: number
  byWorkflow: Record<WorkflowStatus, number>
  withoutProject: number
  errors: number
  missing: number
}

/* ------------------------------------------------------------------ */
/* Helpers shared by main and renderer                                */
/* ------------------------------------------------------------------ */

/** Display aspect ratio, e.g. "9:16". Common ratios are snapped; others shown as decimals. */
export function aspectRatioLabel(width: number | null | undefined, height: number | null | undefined): string {
  if (!width || !height) return '—'
  const known: [number, string][] = [
    [9 / 16, '9:16'], [16 / 9, '16:9'], [1, '1:1'], [4 / 5, '4:5'], [4 / 3, '4:3'], [3 / 4, '3:4'], [21 / 9, '21:9']
  ]
  const ratio = width / height
  for (const [value, label] of known) if (Math.abs(ratio - value) / value < 0.02) return label
  return ratio >= 1 ? `${ratio.toFixed(2)}:1` : `1:${(1 / ratio).toFixed(2)}`
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

export function formatFrameRate(fps: number | null | undefined): string {
  if (!fps || !Number.isFinite(fps)) return '—'
  const rounded = Math.round(fps * 100) / 100
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)} fps`
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function formatChannels(channels: number | null | undefined): string {
  if (!channels) return ''
  if (channels === 1) return 'mono'
  if (channels === 2) return 'stereo'
  return `${channels} ch`
}

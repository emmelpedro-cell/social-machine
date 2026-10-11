import { z } from 'zod'

/**
 * Accounts, connectors and publications (Phase 3).
 *
 * Each platform has a connector with declared capabilities. YouTube uses the
 * official Data API with OAuth. TikTok and Instagram start as "manual"
 * connectors: the app prepares the file and caption, opens the platform's own
 * upload page and records the publication when the user confirms, because
 * their posting APIs require an app review (TikTok: unaudited clients can
 * only post privately).
 */

export type PlatformId = 'youtube' | 'tiktok' | 'instagram'

export type ConnectorCapability =
  /** Upload and publish through the official API. */
  | 'publish'
  /** The user uploads in the platform's own app; the publication is recorded here. */
  | 'manual'
  | 'metrics'
  | 'comments'

export type PlatformInfo = {
  id: PlatformId
  name: string
  capabilities: ConnectorCapability[]
  /** Why capabilities are limited, shown in the UI. */
  note: string
  /** Page where the user uploads manually. */
  uploadUrl: string | null
  /** For OAuth platforms: whether the app has the credentials it needs (client ID). */
  configured: boolean
}

export type ConnectionStatus = 'disconnected' | 'connected' | 'expired' | 'error'

export type Account = {
  id: string
  platformId: PlatformId
  externalAccountId: string | null
  displayName: string
  /** Manual accounts never connect; they exist to group publications by destination. */
  manual: boolean
  connectionStatus: ConnectionStatus
  lastError: string | null
  projectIds: string[]
  createdAt: string
  updatedAt: string
}

export type PublicationStatus =
  | 'draft'
  | 'queued'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'cancelled'
  | 'manual_pending'

export const PUBLICATION_STATUS_LABELS: Record<PublicationStatus, string> = {
  draft: 'Pausada',
  queued: 'Na fila',
  scheduled: 'Agendada',
  publishing: 'Enviando',
  published: 'Publicada',
  failed: 'Falhou',
  cancelled: 'Cancelada',
  manual_pending: 'Aguardando você publicar'
}

export type YouTubePrivacy = 'public' | 'unlisted' | 'private'

/** Platform-specific fields of a publication. */
export type PublicationFields = {
  /** YouTube */
  privacy?: YouTubePrivacy
  madeForKids?: boolean
  categoryId?: string
  tags?: string[]
  notifySubscribers?: boolean
  /** Resumable upload state, so an interrupted upload continues instead of starting over. */
  upload?: { sessionUri: string; totalBytes: number; startedAt: string }
  /** Upload progress 0..1 while publishing. */
  progress?: number
  /**
   * 'platform': the platform publishes at scheduledAt (YouTube `publishAt`; the video is uploaded right away as private).
   * 'local': the app starts the upload (or reminds you, for manual destinations) at scheduledAt; the computer must be on.
   */
  scheduleMode?: ScheduleMode
  /** The scheduled time passed while the app wasn't running; waits for the user instead of publishing late. */
  missed?: boolean
  /** Paused by the user (status 'draft'); resume restores the schedule. */
  paused?: boolean
}

export type ScheduleMode = 'platform' | 'local'

export type Publication = {
  id: string
  contentId: string
  versionId: string | null
  accountId: string
  title: string | null
  caption: string | null
  hashtags: string[]
  fields: PublicationFields
  status: PublicationStatus
  errorMessage: string | null
  externalPostId: string | null
  externalUrl: string | null
  scheduledAt: string | null
  publishedAt: string | null
  createdAt: string
  updatedAt: string
}

/** A publication with names for lists (dashboard, history). */
export type PublicationSummary = Publication & {
  accountName: string
  platformId: PlatformId
  contentName: string
  versionName: string | null
}

/* ------------------------------------------------------------------ */
/* Limits (checked before queueing)                                   */
/* ------------------------------------------------------------------ */

export const YOUTUBE_LIMITS = { title: 100, description: 5000, tagsTotal: 500 }
/** YouTube treats vertical/square uploads up to 3 minutes as Shorts (support.google.com/youtube/answer/15424877). */
export const YOUTUBE_SHORTS_MAX_SECONDS = 180

/** YouTube video categories most relevant here (IDs from videoCategories.list, region-independent for these). */
export const YOUTUBE_CATEGORIES: { id: string; label: string }[] = [
  { id: '17', label: 'Esportes' },
  { id: '24', label: 'Entretenimento' },
  { id: '22', label: 'Pessoas e blogs' },
  { id: '10', label: 'Música' },
  { id: '23', label: 'Comédia' },
  { id: '20', label: 'Jogos' }
]

/* ------------------------------------------------------------------ */
/* IPC inputs                                                         */
/* ------------------------------------------------------------------ */

const uuid = (label: string) => z.string().uuid(label)

export const AccountIdInputSchema = z.object({ id: uuid('Conta inválida') }).strict()

export const AddManualAccountInputSchema = z
  .object({
    platformId: z.enum(['youtube', 'tiktok', 'instagram']),
    displayName: z.string().trim().min(1, 'Dê um nome à conta').max(80),
    projectIds: z.array(uuid('Projeto inválido')).max(50).default([])
  })
  .strict()

export const UpdateAccountInputSchema = z
  .object({
    id: uuid('Conta inválida'),
    displayName: z.string().trim().min(1, 'Dê um nome à conta').max(80).optional(),
    projectIds: z.array(uuid('Projeto inválido')).max(50).optional()
  })
  .strict()

export const ConnectYouTubeInputSchema = z
  .object({ projectIds: z.array(uuid('Projeto inválido')).max(50).default([]) })
  .strict()

export const YouTubeCredentialsInputSchema = z
  .object({
    clientId: z
      .string()
      .trim()
      .regex(/^[\w.-]+\.apps\.googleusercontent\.com$/, 'O Client ID termina em .apps.googleusercontent.com'),
    clientSecret: z.string().trim().max(200).default('')
  })
  .strict()

const hashtag = z.string().trim().min(2).max(100)

export const DestinationInputSchema = z
  .object({
    accountId: uuid('Conta inválida'),
    title: z.string().trim().max(200).nullable(),
    caption: z.string().max(5000).nullable(),
    hashtags: z.array(hashtag).max(60),
    fields: z
      .object({
        privacy: z.enum(['public', 'unlisted', 'private']).optional(),
        madeForKids: z.boolean().optional(),
        categoryId: z.string().regex(/^\d{1,3}$/).optional(),
        tags: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
        notifySubscribers: z.boolean().optional(),
        scheduleMode: z.enum(['platform', 'local']).optional()
      })
      .strict(),
    /** ISO date-time; null = publish now. */
    scheduledAt: z.string().datetime({ offset: true }).nullable().default(null)
  })
  .strict()
export type DestinationInput = z.input<typeof DestinationInputSchema>

export const CreatePublicationsInputSchema = z
  .object({
    versionId: uuid('Versão inválida'),
    destinations: z.array(DestinationInputSchema).min(1, 'Escolha pelo menos um destino').max(20),
    /** Set when the user confirmed publishing a version again to an account that already has it. */
    allowRepeat: z.boolean().default(false),
    /** One key per click: a repeated request (double click, retry of the IPC call) creates nothing twice. */
    requestId: uuid('Pedido inválido')
  })
  .strict()
export type CreatePublicationsInput = z.input<typeof CreatePublicationsInputSchema>

export const PublicationIdInputSchema = z.object({ id: uuid('Publicação inválida') }).strict()

export const MarkPublishedInputSchema = z
  .object({
    id: uuid('Publicação inválida'),
    url: z
      .string()
      .trim()
      .max(500)
      .refine((v) => v === '' || /^https:\/\/[^\s]+$/.test(v), 'Use um link https://')
      .transform((v) => (v ? v : null))
  })
  .strict()

export const PublicationListInputSchema = z
  .object({ contentId: uuid('Conteúdo inválido').optional(), limit: z.number().int().min(1).max(500).optional() })
  .strict()

export type CreatePublicationsResult = { created: Publication[] }

export const RescheduleInputSchema = z
  .object({ id: uuid('Publicação inválida'), scheduledAt: z.string().datetime({ offset: true }) })
  .strict()

/** A publication in the queue/calendar, with its project for filtering and colors. */
export type QueueItem = PublicationSummary & { projectId: string | null }

export const NextSlotsInputSchema = z
  .object({ accountId: uuid('Conta inválida'), count: z.number().int().min(1).max(20).default(1), after: z.string().datetime({ offset: true }).optional() })
  .strict()

export const QueueRangeInputSchema = z
  .object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) })
  .strict()

/* ------------------------------------------------------------------ */
/* Posting preferences (queue settings)                               */
/* ------------------------------------------------------------------ */

/** 0 = Sunday … 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6
export const WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'] as const

export type QueueSettings = {
  accountId: string
  enabled: boolean
  days: Weekday[]
  /** Local times "HH:MM", sorted. */
  times: string[]
  timezone: string
}

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário no formato HH:MM')

export const QueueSettingsInputSchema = z
  .object({
    accountId: uuid('Conta inválida'),
    enabled: z.boolean(),
    days: z.array(z.number().int().min(0).max(6)).max(7),
    times: z.array(time).max(12),
    timezone: z.string().min(1).max(64)
  })
  .strict()

/** Default planning slots: every day at 12:00 and 19:00. A preference, not a promise of reach. */
export function defaultQueueSettings(accountId: string, timezone: string): QueueSettings {
  return { accountId, enabled: true, days: [0, 1, 2, 3, 4, 5, 6], times: ['12:00', '19:00'], timezone }
}

/** A publication occupying a time slot (for free-slot search and calendars). */
export function isScheduledLike(p: Pick<Publication, 'status'>): boolean {
  return p.status === 'scheduled' || p.status === 'queued' || p.status === 'publishing' || p.status === 'draft'
}

export type PublicationEvent =
  | { type: 'publication'; publication: Publication }
  | { type: 'accounts' }

/** Builds the caption: the text, then hashtags (each starting with #), without duplicates. */
export function composeCaption(text: string | null, hashtags: readonly string[]): string {
  const tags = [...new Set(hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)))]
  const body = (text ?? '').trim()
  return [body, tags.join(' ')].filter(Boolean).join('\n\n')
}

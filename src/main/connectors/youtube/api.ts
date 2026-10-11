import { open } from 'node:fs/promises'
import type { Fetch, GoogleEndpoints } from './oauth'
import { GOOGLE_ENDPOINTS } from './oauth'

/** An error from the YouTube API, with a user-facing Portuguese message. */
export class YouTubeApiError extends Error {
  override name = 'YouTubeApiError'
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string | null,
    /** Worth retrying later (server error, network, rate limit). */
    readonly transient: boolean,
    /** The access token was rejected. */
    readonly unauthorized = false
  ) {
    super(message)
  }
}

const REASON_MESSAGES: Record<string, string> = {
  quotaExceeded: 'A cota diária da API do YouTube acabou. Tente de novo amanhã (a cota é renovada à meia-noite, horário do Pacífico).',
  uploadLimitExceeded: 'O canal atingiu o limite de envios do YouTube por enquanto. Tente mais tarde.',
  youtubeSignupRequired: 'Essa conta do Google ainda não tem um canal do YouTube. Crie o canal e conecte de novo.',
  forbidden: 'O YouTube não permitiu o envio para esse canal.',
  invalidTitle: 'O título não foi aceito pelo YouTube.',
  invalidDescription: 'A descrição não foi aceita pelo YouTube.',
  invalidTags: 'As tags não foram aceitas pelo YouTube.',
  invalidCategoryId: 'A categoria escolhida não existe para esse canal.',
  mediaBodyRequired: 'O arquivo de vídeo não chegou ao YouTube.',
  accessNotConfigured:
    'A YouTube Analytics API não está ativada no seu projeto do Google Cloud. Ative-a (APIs e serviços → Biblioteca → YouTube Analytics API) para ver tempo assistido, compartilhamentos e inscritos ganhos.',
  SERVICE_DISABLED:
    'A YouTube Analytics API não está ativada no seu projeto do Google Cloud. Ative-a (APIs e serviços → Biblioteca → YouTube Analytics API) para ver tempo assistido, compartilhamentos e inscritos ganhos.',
  insufficientPermissions: 'O login do YouTube não tem permissão para ler estatísticas. Reconecte a conta em Contas.',
  rateLimitExceeded: 'Muitos pedidos ao YouTube em pouco tempo. Tentando de novo em instantes.',
  userRateLimitExceeded: 'Muitos pedidos ao YouTube em pouco tempo. Tentando de novo em instantes.'
}

export async function apiError(response: Response, fallback: string): Promise<YouTubeApiError> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string; errors?: { reason?: string }[]; status?: string }
  } | null
  const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? null
  const transient =
    response.status >= 500 || response.status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'
  const message =
    (reason && REASON_MESSAGES[reason]) ??
    (response.status === 401
      ? 'O YouTube recusou o login. Conecte a conta de novo.'
      : `${fallback} (${response.status}${body?.error?.message ? `: ${body.error.message}` : ''}).`)
  return new YouTubeApiError(message, response.status, reason, transient, response.status === 401)
}

export async function getMyChannel(
  fetch: Fetch,
  accessToken: string,
  endpoints: GoogleEndpoints = GOOGLE_ENDPOINTS
): Promise<{ id: string; title: string }> {
  const response = await fetch(`${endpoints.api}/channels?part=snippet&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!response.ok) throw await apiError(response, 'Não foi possível ler o canal')
  const body = (await response.json()) as { items?: { id: string; snippet?: { title?: string } }[] }
  const channel = body.items?.[0]
  if (!channel) throw new YouTubeApiError(REASON_MESSAGES['youtubeSignupRequired']!, 404, 'youtubeSignupRequired', false)
  return { id: channel.id, title: channel.snippet?.title ?? channel.id }
}

export type VideoMetadata = {
  title: string
  description: string
  tags: string[]
  categoryId: string
  privacyStatus: 'public' | 'unlisted' | 'private'
  madeForKids: boolean
  /** ISO time: YouTube publishes the (private) video then. Requires privacyStatus 'private'. */
  publishAt?: string
}

/** YouTube rejects "<" and ">" in titles and descriptions; titles are limited to 100 characters. */
export function sanitizeMetadata(meta: VideoMetadata): VideoMetadata {
  const clean = (s: string) => s.replace(/[<>]/g, '')
  let tags = meta.tags.map((t) => clean(t).replace(/^#/, '').trim()).filter(Boolean)
  // The tags field is limited to 500 characters in total (counting separators).
  while (tags.join(',').length > 500) tags = tags.slice(0, -1)
  return {
    ...meta,
    title: clean(meta.title).trim().slice(0, 100),
    description: clean(meta.description).slice(0, 5000),
    tags
  }
}

/** Chunk size: a multiple of 256 KiB, as the resumable protocol requires for all but the last chunk. */
export const CHUNK_SIZE = 8 * 1024 * 1024

export type UploadSession = { sessionUri: string; totalBytes: number }

export type UploadOptions = {
  fetch: Fetch
  /** Returns a valid access token; called again with `forceRefresh` after a 401. */
  accessToken: (forceRefresh?: boolean) => Promise<string>
  filePath: string
  totalBytes: number
  metadata: VideoMetadata
  notifySubscribers: boolean
  /** A session from an earlier, interrupted attempt. */
  session: UploadSession | null
  onSession: (session: UploadSession | null) => void
  onProgress: (fraction: number) => void
  signal?: AbortSignal
  endpoints?: GoogleEndpoints
  chunkSize?: number
  /** Waits between retries (tests make it instant). */
  sleep?: (ms: number) => Promise<void>
  maxRetries?: number
}

type ChunkResult = { done: true; videoId: string } | { done: false; nextOffset: number }

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Uploads a video with the resumable protocol: one session, chunks of
 * CHUNK_SIZE, progress per chunk. After a network error or 5xx it asks the
 * server how much arrived and continues from there (exponential backoff).
 * A session saved by `onSession` lets a later attempt — even after the app
 * restarted — continue instead of uploading the whole file again.
 */
export async function uploadVideo(options: UploadOptions): Promise<{ videoId: string }> {
  const endpoints = options.endpoints ?? GOOGLE_ENDPOINTS
  const chunkSize = options.chunkSize ?? CHUNK_SIZE
  const sleep = options.sleep ?? defaultSleep
  const maxRetries = options.maxRetries ?? 6
  const metadata = sanitizeMetadata(options.metadata)
  const total = options.totalBytes

  const authorized = async (init: RequestInit, url: string): Promise<Response> => {
    let token = await options.accessToken()
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init.headers)
      headers.set('Authorization', `Bearer ${token}`)
      const response = await options.fetch(url, { ...init, headers, signal: options.signal })
      if (response.status !== 401 || attempt > 0) return response
      token = await options.accessToken(true)
    }
  }

  const startSession = async (): Promise<UploadSession> => {
    const url =
      `${endpoints.upload}/videos?uploadType=resumable&part=${encodeURIComponent('snippet,status')}` +
      `&notifySubscribers=${options.notifySubscribers ? 'true' : 'false'}`
    const response = await authorized(
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(total),
          'X-Upload-Content-Type': 'video/mp4'
        },
        body: JSON.stringify({
          snippet: {
            title: metadata.title,
            description: metadata.description,
            tags: metadata.tags,
            categoryId: metadata.categoryId
          },
          status: {
            privacyStatus: metadata.publishAt ? 'private' : metadata.privacyStatus,
            selfDeclaredMadeForKids: metadata.madeForKids,
            embeddable: true,
            ...(metadata.publishAt ? { publishAt: metadata.publishAt } : {})
          }
        })
      },
      url
    )
    if (!response.ok) throw await apiError(response, 'O YouTube recusou o início do envio')
    const location = response.headers.get('Location')
    if (!location) throw new YouTubeApiError('O YouTube não devolveu o endereço de envio.', response.status, null, true)
    const session = { sessionUri: location, totalBytes: total }
    options.onSession(session)
    return session
  }

  const parseDone = async (response: Response): Promise<ChunkResult> => {
    const body = (await response.json().catch(() => ({}))) as { id?: string }
    if (!body.id) throw new YouTubeApiError('O YouTube terminou o envio mas não devolveu o ID do vídeo.', response.status, null, false)
    return { done: true, videoId: body.id }
  }

  const nextOffsetFrom = (response: Response): number => {
    const range = response.headers.get('Range')
    const match = range ? /bytes=0-(\d+)/.exec(range) : null
    return match ? Number(match[1]) + 1 : 0
  }

  /** Asks how much of the file the server has. */
  const queryStatus = async (session: UploadSession): Promise<ChunkResult | 'expired'> => {
    const response = await authorized(
      { method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${total}` } },
      session.sessionUri
    )
    if (response.status === 200 || response.status === 201) return parseDone(response)
    if (response.status === 308) return { done: false, nextOffset: nextOffsetFrom(response) }
    if (response.status === 404 || response.status === 410) return 'expired'
    throw await apiError(response, 'Não foi possível consultar o envio')
  }

  const file = await open(options.filePath, 'r')
  try {
    let session = options.session && options.session.totalBytes === total ? options.session : null
    let offset = 0
    if (session) {
      const status = await queryStatus(session).catch((e: unknown) => {
        if (e instanceof YouTubeApiError && !e.transient) return 'expired' as const
        throw e
      })
      if (status === 'expired') {
        session = null
        options.onSession(null)
      } else if (status.done) {
        options.onProgress(1)
        return { videoId: status.videoId }
      } else {
        offset = status.nextOffset
      }
    }
    if (!session) session = await startSession()

    let retries = 0
    while (true) {
      if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
      const end = Math.min(offset + chunkSize, total) - 1
      const length = end - offset + 1
      const buffer = Buffer.alloc(length)
      await file.read(buffer, 0, length, offset)

      let result: ChunkResult
      try {
        const response = await authorized(
          {
            method: 'PUT',
            headers: {
              'Content-Length': String(length),
              'Content-Type': 'video/mp4',
              'Content-Range': `bytes ${offset}-${end}/${total}`
            },
            body: buffer
          },
          session.sessionUri
        )
        if (response.status === 200 || response.status === 201) result = await parseDone(response)
        else if (response.status === 308) result = { done: false, nextOffset: nextOffsetFrom(response) }
        else if (response.status === 404 || response.status === 410) {
          // The session expired before finishing: start again from zero.
          options.onSession(null)
          session = await startSession()
          offset = 0
          continue
        } else throw await apiError(response, 'O YouTube recusou o envio')
        retries = 0
      } catch (error) {
        if ((error as Error).name === 'AbortError' || options.signal?.aborted) throw error
        const transient = !(error instanceof YouTubeApiError) || error.transient
        if (!transient || retries >= maxRetries) throw error
        retries++
        await sleep(Math.min(60_000, 1000 * 2 ** retries) + Math.floor(Math.random() * 500))
        // Ask the server what it has and continue from there; never assume.
        const status = await queryStatus(session).catch(() => null)
        if (status === 'expired') {
          options.onSession(null)
          session = await startSession()
          offset = 0
        } else if (status && status.done) {
          options.onProgress(1)
          return { videoId: status.videoId }
        } else if (status) {
          offset = status.nextOffset
        }
        continue
      }

      if (result.done) {
        options.onProgress(1)
        return { videoId: result.videoId }
      }
      offset = result.nextOffset
      options.onProgress(total ? offset / total : 0)
    }
  } finally {
    await file.close()
  }
}

/* ------------------------------------------------------------------ */
/* Metrics                                                            */
/* ------------------------------------------------------------------ */

export type VideoStats = { views: number | null; likes: number | null; comments: number | null }

const toNum = (v: unknown): number | null => (v === undefined || v === null || v === '' ? null : Number(v))

/**
 * Public counters from videos.list (1 quota unit per call, up to 50 ids).
 * A counter the owner hid (e.g. likes) is absent and stays null. Videos not
 * returned (deleted, or no longer accessible) are missing from the map.
 */
export async function getVideoStats(
  fetch: Fetch,
  accessToken: string,
  ids: readonly string[],
  endpoints: GoogleEndpoints = GOOGLE_ENDPOINTS
): Promise<Map<string, VideoStats>> {
  const out = new Map<string, VideoStats>()
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const response = await fetch(`${endpoints.api}/videos?part=statistics&id=${chunk.map(encodeURIComponent).join(',')}&maxResults=50`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })
    if (!response.ok) throw await apiError(response, 'Não foi possível ler as estatísticas dos vídeos')
    const body = (await response.json()) as { items?: { id: string; statistics?: Record<string, string> }[] }
    for (const item of body.items ?? []) {
      const s = item.statistics ?? {}
      out.set(item.id, { views: toNum(s['viewCount']), likes: toNum(s['likeCount']), comments: toNum(s['commentCount']) })
    }
  }
  return out
}

export type ChannelStats = { subscribers: number | null; views: number | null; videos: number | null }

/** Channel counters (channels.list, 1 unit). A hidden subscriber count stays null. */
export async function getChannelStats(fetch: Fetch, accessToken: string, endpoints: GoogleEndpoints = GOOGLE_ENDPOINTS): Promise<ChannelStats> {
  const response = await fetch(`${endpoints.api}/channels?part=statistics&mine=true`, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!response.ok) throw await apiError(response, 'Não foi possível ler as estatísticas do canal')
  const body = (await response.json()) as { items?: { statistics?: Record<string, string | boolean> }[] }
  const s = body.items?.[0]?.statistics ?? {}
  return {
    subscribers: s['hiddenSubscriberCount'] === true ? null : toNum(s['subscriberCount']),
    views: toNum(s['viewCount']),
    videos: toNum(s['videoCount'])
  }
}

export type VideoAnalytics = {
  watchTimeSeconds: number | null
  averageViewDurationSeconds: number | null
  averageViewPercentage: number | null
  shares: number | null
  subscribersGained: number | null
}

const ANALYTICS_METRICS = ['estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage', 'shares', 'subscribersGained'] as const

/**
 * Per-video totals from the YouTube Analytics API (reports.query with the
 * `video` dimension) from `startDate` to today. Analytics data lags by a day
 * or more, so very new videos may be absent: they stay null, never zero.
 */
export async function getVideoAnalytics(
  fetch: Fetch,
  accessToken: string,
  ids: readonly string[],
  startDate: string,
  endDate: string,
  endpoints: GoogleEndpoints = GOOGLE_ENDPOINTS
): Promise<Map<string, VideoAnalytics>> {
  const out = new Map<string, VideoAnalytics>()
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const params = new URLSearchParams({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: ANALYTICS_METRICS.join(','),
      dimensions: 'video',
      filters: `video==${chunk.join(',')}`,
      sort: '-estimatedMinutesWatched',
      maxResults: '200'
    })
    const response = await fetch(`${endpoints.analytics}/reports?${params.toString()}`, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!response.ok) throw await apiError(response, 'Não foi possível ler o YouTube Analytics')
    const body = (await response.json()) as { columnHeaders?: { name: string }[]; rows?: (string | number)[][] }
    const names = (body.columnHeaders ?? []).map((h) => h.name)
    const col = (row: (string | number)[], name: string) => {
      const index = names.indexOf(name)
      return index === -1 ? null : toNum(row[index])
    }
    for (const row of body.rows ?? []) {
      const videoId = String(row[names.indexOf('video')])
      const minutes = col(row, 'estimatedMinutesWatched')
      out.set(videoId, {
        watchTimeSeconds: minutes === null ? null : minutes * 60,
        averageViewDurationSeconds: col(row, 'averageViewDuration'),
        averageViewPercentage: col(row, 'averageViewPercentage'),
        shares: col(row, 'shares'),
        subscribersGained: col(row, 'subscribersGained')
      })
    }
  }
  return out
}

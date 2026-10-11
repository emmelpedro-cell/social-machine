import { YOUTUBE_LIMITS, YOUTUBE_SHORTS_MAX_SECONDS, composeCaption, type Account, type DestinationInput, type PlatformInfo } from '../../../shared/publishing'
import { UnavailableError } from '../../errors'
import type { Logger } from '../../logger'
import type { AccountRecord, AccountsRepository } from '../../repositories/accounts'
import type { SecretStore } from '../../secrets/token-store'
import type { YouTubeClientConfig } from '../config'
import {
  ReauthorizeError,
  type CollectedMetrics,
  type Connector,
  type ExternalComment,
  type InboxCapabilities,
  type MetricsRequest,
  type PublishableVersion,
  type PublishContext,
  type PublishResult
} from '../types'
import {
  getChannelStats,
  getMyChannel,
  getVideoAnalytics,
  getVideoStats,
  insertReply,
  listCommentThreads,
  uploadVideo,
  YouTubeApiError,
  type CommentResource,
  type VideoAnalytics
} from './api'
import type { MetricValues } from '../../../shared/analytics'
import {
  authorizeWithLoopback,
  GOOGLE_ENDPOINTS,
  OAuthError,
  refreshTokens,
  revokeTokens,
  YOUTUBE_REPLY_SCOPE,
  YOUTUBE_SCOPES,
  type Fetch,
  type GoogleEndpoints,
  type StoredTokens
} from './oauth'

export type YouTubeConnectorOptions = {
  accounts: AccountsRepository
  secrets: SecretStore
  config: YouTubeClientConfig
  fetch: Fetch
  openBrowser: (url: string) => Promise<void> | void
  logger: Logger
  endpoints?: GoogleEndpoints
  now?: () => number
  /** For tests: makes upload retries instant. */
  sleep?: (ms: number) => Promise<void>
  chunkSize?: number
}

export function isShort(version: PublishableVersion): boolean {
  return version.height >= version.width && version.durationSeconds <= YOUTUBE_SHORTS_MAX_SECONDS
}

/** YouTube through the official Data API v3 (uploads in their own quota bucket of 100 per day per project). */
export class YouTubeConnector implements Connector {
  readonly supportsPlatformScheduling = true
  private readonly endpoints: GoogleEndpoints
  private readonly now: () => number

  constructor(private readonly options: YouTubeConnectorOptions) {
    this.endpoints = options.endpoints ?? GOOGLE_ENDPOINTS
    this.now = options.now ?? Date.now
  }

  info(): PlatformInfo {
    return {
      id: 'youtube',
      name: 'YouTube',
      capabilities: ['publish', 'metrics', 'comments'],
      note:
        'Envio pela API oficial do YouTube (OAuth). Requer um OAuth Client ID do tipo "App para computador" criado por você no Google Cloud. ' +
        'Com o projeto do Google em modo "Teste", o login expira a cada 7 dias e a conta precisa ser reconectada.',
      uploadUrl: 'https://studio.youtube.com/',
      configured: this.options.config.get() !== null
    }
  }

  validate(_version: PublishableVersion, destination: DestinationInput): string[] {
    const problems: string[] = []
    const title = (destination.title ?? '').replace(/[<>]/g, '').trim()
    if (!title) problems.push('O YouTube exige um título.')
    if (title.length > YOUTUBE_LIMITS.title) problems.push(`O título passa de ${YOUTUBE_LIMITS.title} caracteres.`)
    const description = composeCaption(destination.caption, destination.hashtags)
    if (description.length > YOUTUBE_LIMITS.description) problems.push(`A descrição passa de ${YOUTUBE_LIMITS.description} caracteres.`)
    if (destination.fields.madeForKids === undefined) problems.push('Informe se o vídeo é “feito para crianças” (exigência do YouTube).')
    return problems
  }

  notes(version: PublishableVersion): string[] {
    return isShort(version)
      ? ['Vai aparecer como Short (vertical ou quadrado, até 3 minutos).']
      : version.height >= version.width
        ? ['Vertical com mais de 3 minutos: vai como vídeo comum, não como Short.']
        : ['Horizontal: vai como vídeo comum.']
  }

  private client() {
    const client = this.options.config.get()
    if (!client) throw new UnavailableError('Configure o Client ID do YouTube em Contas antes de conectar.')
    return client
  }

  async connect(projectIds: string[]): Promise<Account> {
    const client = this.client()
    const tokens = await authorizeWithLoopback({
      client,
      scopes: YOUTUBE_SCOPES,
      openBrowser: this.options.openBrowser,
      fetch: this.options.fetch,
      endpoints: this.endpoints,
      now: this.now
    })
    const channel = await getMyChannel(this.options.fetch, tokens.accessToken, this.endpoints)
    const existing = this.options.accounts.findByExternal('youtube', channel.id)
    const tokenRef = this.options.secrets.save(tokens, existing?.tokenRef ?? undefined)
    const { account, previousTokenRef } = this.options.accounts.upsertConnected({
      platformId: 'youtube',
      externalAccountId: channel.id,
      displayName: channel.title,
      tokenRef,
      projectIds
    })
    if (previousTokenRef && previousTokenRef !== tokenRef) this.options.secrets.delete(previousTokenRef)
    this.options.logger.info('YouTube account connected', { account: account.id, channel: channel.id })
    return account
  }

  async disconnect(account: AccountRecord): Promise<void> {
    if (!account.tokenRef) return
    const tokens = this.options.secrets.load<StoredTokens>(account.tokenRef)
    if (tokens) await revokeTokens(this.options.fetch, tokens, this.endpoints)
  }

  /** A valid access token for the account, refreshed when close to expiry. */
  private async accessToken(account: AccountRecord, force = false): Promise<string> {
    const ref = account.tokenRef
    const tokens = ref ? this.options.secrets.load<StoredTokens>(ref) : null
    if (!ref || !tokens) {
      this.options.accounts.setStatus(account.id, 'disconnected', 'Login não encontrado.')
      throw new ReauthorizeError('A conta não está conectada. Conecte-a de novo em Contas.')
    }
    if (!force && tokens.expiresAt - this.now() > 60_000) return tokens.accessToken
    try {
      const fresh = await refreshTokens({ client: this.client(), tokens, fetch: this.options.fetch, endpoints: this.endpoints, now: this.now })
      this.options.secrets.save(fresh, ref)
      return fresh.accessToken
    } catch (error) {
      if (error instanceof OAuthError && error.reauthorize) {
        this.options.accounts.setStatus(account.id, 'expired', error.message)
        throw new ReauthorizeError(error.message)
      }
      throw error
    }
  }

  async publish(ctx: PublishContext): Promise<PublishResult> {
    const { publication, version } = ctx
    const fields = publication.fields
    // YouTube publishes by itself at the scheduled time: upload now as private with publishAt.
    const publishAt =
      fields.scheduleMode === 'platform' && publication.scheduledAt && new Date(publication.scheduledAt).getTime() > this.now() + 60_000
        ? new Date(publication.scheduledAt).toISOString()
        : undefined
    try {
      const { videoId } = await uploadVideo({
        fetch: this.options.fetch,
        accessToken: (force) => this.accessToken(ctx.account, force),
        filePath: version.filePath,
        totalBytes: version.fileSize,
        metadata: {
          title: publication.title ?? '',
          description: composeCaption(publication.caption, publication.hashtags),
          tags: fields.tags ?? publication.hashtags,
          categoryId: fields.categoryId ?? '17',
          privacyStatus: fields.privacy ?? 'public',
          madeForKids: fields.madeForKids ?? false,
          publishAt
        },
        notifySubscribers: fields.notifySubscribers ?? true,
        session: fields.upload ? { sessionUri: fields.upload.sessionUri, totalBytes: fields.upload.totalBytes } : null,
        onSession: (session) =>
          ctx.saveFields({
            upload: session ? { ...session, startedAt: new Date(this.now()).toISOString() } : undefined
          }),
        onProgress: ctx.onProgress,
        signal: ctx.signal,
        endpoints: this.endpoints,
        sleep: this.options.sleep,
        chunkSize: this.options.chunkSize
      })
      if (ctx.account.connectionStatus !== 'connected') this.options.accounts.setStatus(ctx.account.id, 'connected')
      const url = isShort(version) ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`
      return { externalPostId: videoId, externalUrl: url, scheduledOnPlatform: Boolean(publishAt) }
    } catch (error) {
      if (error instanceof YouTubeApiError && error.unauthorized) {
        this.options.accounts.setStatus(ctx.account.id, 'expired', error.message)
        throw new ReauthorizeError(error.message)
      }
      throw error
    }
  }

  /** Runs an API call with a valid token; on 401 refreshes once, then asks to reconnect. */
  private async withToken<T>(account: AccountRecord, fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.accessToken(account))
    } catch (error) {
      if (!(error instanceof YouTubeApiError && error.unauthorized)) throw error
      try {
        return await fn(await this.accessToken(account, true))
      } catch (again) {
        if (again instanceof YouTubeApiError && again.unauthorized) {
          this.options.accounts.setStatus(account.id, 'expired', again.message)
          throw new ReauthorizeError(again.message)
        }
        throw again
      }
    }
  }

  private grantedScopes(account: AccountRecord): string[] {
    const tokens = account.tokenRef ? this.options.secrets.load<StoredTokens>(account.tokenRef) : null
    return (tokens?.scope ?? '').split(/\s+/).filter(Boolean)
  }

  inboxCapabilities(account: AccountRecord): InboxCapabilities {
    if (account.connectionStatus !== 'connected') {
      return { readComments: false, reply: false, limitation: 'Conta desconectada: reconecte em Contas para ver os comentários.' }
    }
    const scopes = this.grantedScopes(account)
    // Tokens saved before scopes were recorded have an empty list: let the API decide.
    const reply = scopes.length === 0 || scopes.includes(YOUTUBE_REPLY_SCOPE)
    return {
      readComments: true,
      reply,
      limitation: reply ? null : 'Para responder pelo app, reconecte a conta em Contas e autorize “gerenciar sua conta do YouTube”.'
    }
  }

  /** Comment threads on the channel's videos (top-level comments and the replies YouTube includes), newest first. */
  async fetchComments(account: AccountRecord, options: { knownUntil: string | null; maxPages: number }): Promise<ExternalComment[]> {
    const channelId = account.externalAccountId
    if (!channelId) throw new ReauthorizeError('Canal desconhecido. Conecte a conta de novo.')
    const out: ExternalComment[] = []
    let pageToken: string | null = null
    for (let page = 0; page < options.maxPages; page++) {
      const result = await this.withToken(account, (t) => listCommentThreads(this.options.fetch, t, channelId, pageToken, this.endpoints))
      let reachedKnown = false
      for (const thread of result.threads) {
        const top = thread.snippet?.topLevelComment
        if (!top) continue
        const canReply = thread.snippet?.canReply !== false
        out.push(toExternal(top, thread.id, 'comment', thread.snippet?.videoId ?? null, channelId, canReply))
        for (const reply of thread.replies?.comments ?? []) out.push(toExternal(reply, thread.id, 'reply', thread.snippet?.videoId ?? null, channelId, canReply))
        // Threads come ordered by latest activity; once a whole thread is older than what we have, stop.
        const latest = [top, ...(thread.replies?.comments ?? [])].map((c) => c.snippet?.updatedAt ?? c.snippet?.publishedAt ?? '').sort().at(-1) ?? ''
        if (options.knownUntil && latest && latest < options.knownUntil) reachedKnown = true
      }
      pageToken = result.nextPageToken
      if (!pageToken || reachedKnown) break
    }
    if (account.connectionStatus !== 'connected') this.options.accounts.setStatus(account.id, 'connected')
    return out
  }

  async replyToComment(account: AccountRecord, threadId: string, text: string): Promise<ExternalComment> {
    const caps = this.inboxCapabilities(account)
    if (!caps.reply) throw new ReauthorizeError(caps.limitation ?? 'Reconecte a conta para responder.')
    const created = await this.withToken(account, (t) => insertReply(this.options.fetch, t, threadId, text, this.endpoints))
    return toExternal(created, threadId, 'reply', created.snippet?.videoId ?? null, account.externalAccountId ?? '', true, true)
  }

  /**
   * Counters from the Data API (fresh) plus watch time, shares and subscribers
   * gained from the YouTube Analytics API (lagging a day or more). If Analytics
   * fails, the counters are still saved and the reason is returned as a warning.
   */
  async collectMetrics(account: AccountRecord, items: readonly MetricsRequest[]): Promise<CollectedMetrics> {
    const call = <T>(fn: (token: string) => Promise<T>) => this.withToken(account, fn)
    const ids = [...new Set(items.map((i) => i.externalPostId))]
    const stats = ids.length ? await call((t) => getVideoStats(this.options.fetch, t, ids, this.endpoints)) : new Map()
    let warning: string | null = null
    let analytics: Map<string, VideoAnalytics> | null = null
    if (ids.length) {
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
      const start = day(Math.min(...items.map((i) => new Date(i.publishedAt).getTime())))
      try {
        analytics = await call((t) => getVideoAnalytics(this.options.fetch, t, ids, start, day(this.now()), this.endpoints))
      } catch (error) {
        if (error instanceof ReauthorizeError) throw error
        warning = error instanceof YouTubeApiError ? error.message : `YouTube Analytics indisponível: ${(error as Error).message}`
        this.options.logger.warn('YouTube Analytics failed', { account: account.id, error })
      }
    }
    let channel: CollectedMetrics['account'] = null
    try {
      const c = await call((t) => getChannelStats(this.options.fetch, t, this.endpoints))
      channel = { followers: c.subscribers, totalViews: c.views, videoCount: c.videos }
    } catch (error) {
      if (error instanceof ReauthorizeError) throw error
      this.options.logger.warn('Channel statistics failed', { account: account.id, error })
    }
    const publications = new Map<string, MetricValues>()
    for (const item of items) {
      const s = stats.get(item.externalPostId)
      if (!s) continue
      const a = analytics?.get(item.externalPostId) ?? null
      publications.set(item.publicationId, {
        views: s.views,
        likes: s.likes,
        comments: s.comments,
        shares: a?.shares ?? null,
        followersGained: a?.subscribersGained ?? null,
        watchTimeSeconds: a?.watchTimeSeconds ?? null,
        averageViewDurationSeconds: a?.averageViewDurationSeconds ?? null,
        extra: { averageViewPercentage: a?.averageViewPercentage ?? null, analyticsIncluded: a !== null }
      })
    }
    if (account.connectionStatus !== 'connected') this.options.accounts.setStatus(account.id, 'connected')
    return { publications, account: channel, warning }
  }
}

function toExternal(
  c: CommentResource,
  threadId: string,
  type: 'comment' | 'reply',
  videoId: string | null,
  channelId: string,
  canReply: boolean,
  own = false
): ExternalComment {
  const s = c.snippet ?? {}
  return {
    externalId: c.id,
    threadId,
    type,
    videoId: s.videoId ?? videoId,
    text: s.textOriginal ?? s.textDisplay ?? '',
    author: s.authorDisplayName ?? null,
    authorUrl: s.authorChannelUrl ?? null,
    own: own || (Boolean(channelId) && s.authorChannelId?.value === channelId),
    createdAt: s.publishedAt ?? new Date().toISOString(),
    updatedAt: s.updatedAt ?? null,
    likeCount: typeof s.likeCount === 'number' ? s.likeCount : null,
    canReply
  }
}

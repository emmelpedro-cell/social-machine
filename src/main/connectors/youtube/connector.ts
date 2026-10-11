import { YOUTUBE_LIMITS, YOUTUBE_SHORTS_MAX_SECONDS, composeCaption, type Account, type DestinationInput, type PlatformInfo } from '../../../shared/publishing'
import { UnavailableError } from '../../errors'
import type { Logger } from '../../logger'
import type { AccountRecord, AccountsRepository } from '../../repositories/accounts'
import type { SecretStore } from '../../secrets/token-store'
import type { YouTubeClientConfig } from '../config'
import { ReauthorizeError, type Connector, type PublishableVersion, type PublishContext, type PublishResult } from '../types'
import { getMyChannel, uploadVideo, YouTubeApiError } from './api'
import {
  authorizeWithLoopback,
  GOOGLE_ENDPOINTS,
  OAuthError,
  refreshTokens,
  revokeTokens,
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
      capabilities: ['publish'],
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
          madeForKids: fields.madeForKids ?? false
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
      return { externalPostId: videoId, externalUrl: url }
    } catch (error) {
      if (error instanceof YouTubeApiError && error.unauthorized) {
        this.options.accounts.setStatus(ctx.account.id, 'expired', error.message)
        throw new ReauthorizeError(error.message)
      }
      throw error
    }
  }
}

import type { InboxAccountStatus, InboxItem, InboxSyncResult } from '../../shared/inbox'
import type { PlatformId } from '../../shared/publishing'
import { ConflictError, UnavailableError, UnprocessableError } from '../errors'
import type { Logger } from '../logger'
import type { AccountsRepository } from '../repositories/accounts'
import type { InboxRepository } from '../repositories/inbox'
import { ReauthorizeError, type Connector } from '../connectors/types'
import { YouTubeApiError } from '../connectors/youtube/api'
import { OAuthError } from '../connectors/youtube/oauth'

export type InboxEvent = { type: 'inbox' }

export type InboxServiceOptions = {
  inbox: InboxRepository
  accounts: AccountsRepository
  connectors: Record<PlatformId, Connector>
  logger: Logger
  emit: (event: InboxEvent) => void
  notify?: (title: string, body: string) => void
  now?: () => number
  /** Sync interval; 0 disables the timer (tests). */
  tickMs?: number
  /** Pages of 100 threads read per sync at most. */
  maxPages?: number
}

const DAY = 86_400_000

/**
 * Reads comments through the platforms' official APIs into one inbox, and
 * sends replies the user wrote. Nothing is answered automatically.
 */
export class InboxService {
  private readonly now: () => number
  private timer: NodeJS.Timeout | null = null
  private readonly running = new Set<string>()
  private readonly replying = new Set<string>()

  constructor(private readonly options: InboxServiceOptions) {
    this.now = options.now ?? Date.now
  }

  start(): void {
    const interval = this.options.tickMs ?? 15 * 60_000
    const first = setTimeout(() => void this.sync().catch(() => undefined), Math.min(interval, 45_000))
    first.unref?.()
    if (interval > 0) {
      this.timer = setInterval(() => void this.sync().catch(() => undefined), interval)
      this.timer.unref?.()
    }
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  get(id: string): InboxItem {
    return this.options.inbox.get(id)
  }

  list(): InboxItem[] {
    return this.options.inbox.list()
  }

  status(): InboxAccountStatus[] {
    const unread = this.options.inbox.unreadByAccount()
    return this.options.accounts.list().map((account) => {
      const record = this.options.accounts.record(account.id)
      const connector = this.options.connectors[account.platformId]
      const caps =
        !account.manual && connector.inboxCapabilities
          ? connector.inboxCapabilities(record)
          : {
              readComments: false,
              reply: false,
              limitation:
                account.platformId === 'youtube'
                  ? 'Conta manual: conecte o canal pela API em Contas para ver os comentários aqui.'
                  : `A API de comentários do ${account.platformId === 'tiktok' ? 'TikTok' : 'Instagram'} exige um app aprovado pela plataforma. Veja os comentários no app do ${account.platformId === 'tiktok' ? 'TikTok' : 'Instagram'}.`
            }
      const sync = this.options.inbox.syncStatus(account.id)
      return {
        accountId: account.id,
        accountName: account.displayName,
        platformId: account.platformId,
        readComments: caps.readComments,
        reply: caps.reply,
        limitation: caps.limitation,
        checkedAt: sync.checkedAt,
        error: sync.error,
        unread: unread.get(account.id) ?? 0
      }
    })
  }

  /** Reads new comments of every connected account that supports it (or one account). */
  async sync(accountId?: string): Promise<InboxSyncResult> {
    const result: InboxSyncResult = { accounts: 0, newItems: 0, errors: [] }
    const accounts = this.options.accounts.list().filter((a) => !accountId || a.id === accountId)
    if (accountId && accounts.length === 0) throw new ConflictError('Essa conta não existe mais.')
    for (const account of accounts) {
      const record = this.options.accounts.record(account.id)
      const connector = this.options.connectors[account.platformId]
      if (account.manual || !connector.fetchComments || !connector.inboxCapabilities) {
        if (accountId) throw new ConflictError('Essa conta não oferece comentários pela API.')
        continue
      }
      if (record.connectionStatus !== 'connected' || this.running.has(account.id)) continue
      this.running.add(account.id)
      try {
        const firstSync = !this.options.inbox.hasAny(account.id)
        const comments = await connector.fetchComments(record, { knownUntil: this.options.inbox.newest(account.id), maxPages: this.options.maxPages ?? 5 })
        // On the first sync, comments older than a week are history: stored as read, so the inbox starts with what's recent.
        const markReadBefore = firstSync ? new Date(this.now() - 7 * DAY).toISOString() : null
        const created = this.options.inbox.upsert(account.id, comments, (videoId) => this.options.inbox.publicationForVideo(account.id, videoId), markReadBefore)
        this.options.inbox.setSyncStatus(account.id, null)
        result.accounts++
        result.newItems += created.length
        if (created.length && !firstSync) {
          this.options.notify?.(
            created.length === 1 ? 'Novo comentário' : `${created.length} comentários novos`,
            `${account.displayName}: abra a Inbox para ver.`
          )
        }
        this.options.logger.info('Inbox synced', { account: account.id, received: comments.length, new: created.length })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.options.inbox.setSyncStatus(account.id, message)
        result.accounts++
        result.errors.push(`${account.displayName}: ${message}`)
        this.options.logger.warn('Inbox sync failed', { account: account.id, error })
      } finally {
        this.running.delete(account.id)
      }
    }
    if (result.accounts) this.emit()
    return result
  }

  setRead(ids: readonly string[], read: boolean): void {
    this.options.inbox.setRead(ids, read)
    this.emit()
  }

  setResolved(ids: readonly string[], resolved: boolean): void {
    this.options.inbox.setResolved(ids, resolved)
    this.emit()
  }

  /** Sends the reply the user wrote to a comment's thread. One send at a time per comment (no double replies). */
  async reply(id: string, text: string): Promise<InboxItem> {
    const item = this.options.inbox.get(id)
    if (!item.threadId) throw new ConflictError('Esse item não aceita resposta.')
    if (!item.canReply) throw new ConflictError('A plataforma não permite responder a esse comentário.')
    const record = this.options.accounts.record(item.accountId)
    const connector = this.options.connectors[record.platformId]
    if (!connector.replyToComment) throw new ConflictError('Essa plataforma não permite responder pela API. Responda no app da plataforma.')
    if (this.replying.has(id)) throw new ConflictError('A resposta já está sendo enviada.')
    this.replying.add(id)
    try {
      const sent = await connector.replyToComment(record, item.threadId, text)
      this.options.inbox.upsert(item.accountId, [{ ...sent, own: true, videoId: sent.videoId ?? item.externalVideoId }], () => item.publicationId, null)
      this.options.inbox.markReplied(id)
      this.options.logger.info('Reply sent', { account: item.accountId, item: id })
      this.emit()
      return this.options.inbox.get(id)
    } catch (error) {
      // Platform and login errors carry a message meant for the user.
      if (error instanceof ReauthorizeError || error instanceof YouTubeApiError || error instanceof OAuthError) {
        this.options.logger.warn('Reply failed', { account: item.accountId, item: id, error })
        throw new UnprocessableError(error.message)
      }
      if ((error as Error)?.name === 'TypeError') throw new UnavailableError(`Falha de rede: ${(error as Error).message}. Tente de novo.`)
      throw error
    } finally {
      this.replying.delete(id)
    }
  }

  private emit(): void {
    try {
      this.options.emit({ type: 'inbox' })
    } catch (error) {
      this.options.logger.warn('Inbox event delivery failed', { error })
    }
  }
}

import { existsSync, statSync } from 'node:fs'
import {
  type CreatePublicationsResult,
  type DestinationInput,
  type PlatformId,
  type PlatformInfo,
  type Publication,
  type PublicationEvent,
  type PublicationFields
} from '../../shared/publishing'
import { ConflictError, NotFoundError, UnprocessableError } from '../errors'
import type { Logger } from '../logger'
import type { AccountsRepository } from '../repositories/accounts'
import type { PublicationsRepository } from '../repositories/publications'
import type { VersionsRepository } from '../repositories/versions'
import { ReauthorizeError, type Connector, type PublishableVersion } from '../connectors/types'
import { YouTubeApiError } from '../connectors/youtube/api'
import { OAuthError } from '../connectors/youtube/oauth'

export type PublishServiceOptions = {
  publications: PublicationsRepository
  accounts: AccountsRepository
  versions: VersionsRepository
  connectors: Record<PlatformId, Connector>
  logger: Logger
  emit: (event: PublicationEvent) => void
  /** Uploads in parallel across accounts; one at a time per account. */
  concurrency?: number
}

/**
 * Creates one publication per destination and runs the API ones in the
 * background. Each destination is independent: a failure on one never stops
 * the others. Requests carry a client-generated id, so a repeated request
 * (double click, IPC retry) never creates a second publication; publishing
 * the same version to the same account again needs an explicit confirmation.
 */
export class PublishService {
  private readonly queue: string[] = []
  private readonly active = new Map<string, { accountId: string; controller: AbortController }>()
  private readonly cancelled = new Set<string>()
  private shuttingDown = false
  private idleWaiters: (() => void)[] = []

  constructor(private readonly options: PublishServiceOptions) {}

  platforms(): PlatformInfo[] {
    return (Object.keys(this.options.connectors) as PlatformId[]).map((id) => this.options.connectors[id].info())
  }

  /** Re-queues work interrupted by a quit or crash; YouTube uploads continue from their saved session. */
  start(): void {
    const ids = this.options.publications.idsWithStatus(['publishing', 'queued'])
    for (const id of ids) {
      const publication = this.options.publications.setStatus(id, 'queued')
      this.emit({ type: 'publication', publication })
      this.enqueue(id)
    }
    if (ids.length) this.options.logger.info('Resuming publications', { count: ids.length })
  }

  shutdown(): void {
    this.shuttingDown = true
    this.queue.length = 0
    for (const job of this.active.values()) job.controller.abort()
  }

  waitForIdle(): Promise<void> {
    if (this.active.size === 0 && this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  /** Non-blocking remarks for a version on each platform (e.g. "will be a Short"). */
  notes(versionId: string): Record<PlatformId, string[]> {
    const version = this.publishable(versionId)
    const out = {} as Record<PlatformId, string[]>
    for (const id of Object.keys(this.options.connectors) as PlatformId[]) out[id] = this.options.connectors[id].notes(version)
    return out
  }

  create(input: { versionId: string; destinations: DestinationInput[]; allowRepeat: boolean; requestId: string }): CreatePublicationsResult {
    const versionRecord = this.options.versions.get(input.versionId)
    const version = this.publishable(input.versionId)

    // Validate every destination before creating any, so a mistake doesn't leave half a batch.
    const plans = input.destinations.map((destination) => {
      const account = this.options.accounts.record(destination.accountId)
      const connector = this.options.connectors[account.platformId]
      const key = `${input.requestId}:${account.id}`
      const existing = this.options.publications.findByKey(key)
      const problems = existing ? [] : connector.validate(version, destination)
      if (problems.length) throw new UnprocessableError(`${account.displayName}: ${problems.join(' ')}`)
      const manual = account.manual || !connector.publish
      if (!existing && !manual && account.connectionStatus !== 'connected') {
        throw new ConflictError(`A conta ${account.displayName} não está conectada. Reconecte-a em Contas.`)
      }
      if (!existing && !input.allowRepeat && this.options.publications.activeFor(input.versionId, account.id).length) {
        throw new ConflictError(
          `A versão “${versionRecord.name}” já foi publicada (ou está na fila) em ${account.displayName}. Confirme para publicar de novo.`
        )
      }
      return { destination, account, manual, key, existing }
    })

    const created: Publication[] = []
    for (const plan of plans) {
      if (plan.existing) {
        created.push(plan.existing)
        continue
      }
      const fields: PublicationFields = { ...plan.destination.fields }
      const publication = this.options.publications.create({
        contentId: versionRecord.contentId,
        versionId: versionRecord.id,
        accountId: plan.account.id,
        title: plan.destination.title,
        caption: plan.destination.caption,
        hashtags: plan.destination.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)),
        fields,
        status: plan.manual ? 'manual_pending' : 'queued',
        idempotencyKey: plan.key
      })
      created.push(publication)
      this.emit({ type: 'publication', publication })
      if (!plan.manual) this.enqueue(publication.id)
    }
    this.options.logger.info('Publications created', { version: versionRecord.id, count: created.length })
    return { created }
  }

  retry(id: string): Publication {
    const publication = this.options.publications.get(id)
    if (publication.status !== 'failed' && publication.status !== 'cancelled') {
      throw new ConflictError('Só é possível tentar de novo uma publicação que falhou ou foi cancelada.')
    }
    const account = this.options.accounts.record(publication.accountId)
    if (account.manual) throw new ConflictError('Publicações manuais são confirmadas por você, não reenviadas.')
    if (account.connectionStatus !== 'connected') throw new ConflictError(`A conta ${account.displayName} não está conectada. Reconecte-a em Contas.`)
    const updated = this.options.publications.setStatus(id, 'queued')
    this.emit({ type: 'publication', publication: updated })
    this.enqueue(id)
    return updated
  }

  cancel(id: string): Publication {
    const publication = this.options.publications.get(id)
    const job = this.active.get(id)
    if (job) {
      this.cancelled.add(id)
      job.controller.abort()
      return publication
    }
    if (!['queued', 'manual_pending', 'failed'].includes(publication.status)) {
      throw new ConflictError('Essa publicação não pode mais ser cancelada.')
    }
    const index = this.queue.indexOf(id)
    if (index >= 0) this.queue.splice(index, 1)
    const updated = this.options.publications.setStatus(id, 'cancelled')
    this.emit({ type: 'publication', publication: updated })
    return updated
  }

  /** The user confirms a manual publication, optionally with its link. */
  markManualPublished(id: string, url: string | null): Publication {
    const publication = this.options.publications.get(id)
    if (publication.status !== 'manual_pending') throw new ConflictError('Essa publicação não está aguardando confirmação.')
    const updated = this.options.publications.markPublished(id, { externalPostId: null, externalUrl: url })
    this.emit({ type: 'publication', publication: updated })
    return updated
  }

  /* ---------------------------------------------------------------- */
  /* Queue                                                            */
  /* ---------------------------------------------------------------- */

  private enqueue(id: string): void {
    if (this.queue.includes(id) || this.active.has(id)) return
    this.queue.push(id)
    this.pump()
  }

  private pump(): void {
    const limit = this.options.concurrency ?? 2
    const busyAccounts = new Set([...this.active.values()].map((j) => j.accountId))
    for (let i = 0; i < this.queue.length && this.active.size < limit && !this.shuttingDown; ) {
      const id = this.queue[i]!
      const publication = this.options.publications.find(id)
      if (!publication || publication.status !== 'queued') {
        this.queue.splice(i, 1)
        continue
      }
      if (busyAccounts.has(publication.accountId)) {
        i++
        continue
      }
      this.queue.splice(i, 1)
      busyAccounts.add(publication.accountId)
      const controller = new AbortController()
      this.active.set(id, { accountId: publication.accountId, controller })
      void this.run(id, controller.signal).finally(() => {
        this.active.delete(id)
        this.pump()
      })
    }
    if (this.active.size === 0 && this.queue.length === 0) {
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  private async run(id: string, signal: AbortSignal): Promise<void> {
    const repo = this.options.publications
    let publication = repo.setStatus(id, 'publishing')
    this.emit({ type: 'publication', publication })
    let lastProgress = 0
    try {
      const account = this.options.accounts.record(publication.accountId)
      const connector = this.options.connectors[account.platformId]
      if (!connector.publish) throw new UnprocessableError('Essa plataforma não publica pela API.')
      if (!publication.versionId) throw new UnprocessableError('A publicação não tem uma versão.')
      const version = this.publishable(publication.versionId)
      const result = await connector.publish({
        publication,
        account,
        version,
        signal,
        saveFields: (patch) => {
          publication = repo.updateFields(id, patch)
        },
        onProgress: (fraction) => {
          if (fraction - lastProgress < 0.02 && fraction < 1) return
          lastProgress = fraction
          publication = repo.updateFields(id, { progress: fraction })
          this.emit({ type: 'publication', publication })
        }
      })
      publication = repo.markPublished(id, result)
      this.options.logger.info('Published', { id, account: account.id, post: result.externalPostId })
      this.emit({ type: 'publication', publication })
    } catch (error) {
      if (this.shuttingDown) return // stays "publishing"; resumed on next start
      if (this.cancelled.delete(id)) {
        publication = repo.setStatus(id, 'cancelled')
        this.emit({ type: 'publication', publication })
        return
      }
      const message = this.describe(error)
      this.options.logger.warn('Publication failed', { id, message, error })
      publication = repo.setStatus(id, 'failed', message)
      this.emit({ type: 'publication', publication })
      if (error instanceof ReauthorizeError) this.emit({ type: 'accounts' })
    }
  }

  private publishable(versionId: string): PublishableVersion {
    const version = this.options.versions.get(versionId)
    if (version.status !== 'ready' || !version.filePath || !version.width || !version.height || !version.durationSeconds) {
      throw new ConflictError('Essa versão ainda não está pronta para publicar.')
    }
    if (!existsSync(version.filePath)) {
      throw new NotFoundError(`O arquivo da versão “${version.name}” não foi encontrado (${version.filePath}).`)
    }
    return {
      filePath: version.filePath,
      fileSize: statSync(version.filePath).size,
      width: version.width,
      height: version.height,
      durationSeconds: version.durationSeconds
    }
  }

  private describe(error: unknown): string {
    if (error instanceof ReauthorizeError || error instanceof YouTubeApiError || error instanceof OAuthError) return error.message
    if (error instanceof UnprocessableError || error instanceof ConflictError || error instanceof NotFoundError) return error.message
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return 'O arquivo da versão não foi encontrado.'
    if ((error as Error)?.name === 'TypeError') return `Falha de rede: ${(error as Error).message}. Tente de novo.`
    return `A publicação falhou: ${(error as Error)?.message ?? String(error)}`
  }

  private emit(event: PublicationEvent): void {
    try {
      this.options.emit(event)
    } catch (error) {
      this.options.logger.warn('Publication event delivery failed', { error })
    }
  }
}

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
  /** How late (minutes) a local schedule may still run; later ones wait for the user. */
  graceMinutes?: () => number
  /** Desktop notification (manual posts due, missed schedules). */
  notify?: (title: string, body: string) => void
  now?: () => number
  /** Scheduler tick interval; 0 disables the timer (tests call tick()). */
  tickMs?: number
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
  private timer: NodeJS.Timeout | null = null
  private readonly now: () => number

  constructor(private readonly options: PublishServiceOptions) {
    this.now = options.now ?? Date.now
  }

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
    // Schedules that came due while the app was closed are handled now (late ones wait for the user).
    this.tick()
    const interval = this.options.tickMs ?? 20_000
    if (interval > 0) {
      this.timer = setInterval(() => this.tick(), interval)
      this.timer.unref?.()
    }
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
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
      const requested = plan.destination.scheduledAt ? new Date(plan.destination.scheduledAt).getTime() : null
      // A time in the past or within the next 30 seconds means "now".
      const scheduledAt = requested && requested > this.now() + 30_000 ? new Date(requested).toISOString() : null
      const connector = this.options.connectors[plan.account.platformId]
      const fields: PublicationFields = { ...plan.destination.fields }
      let status: Publication['status'] = plan.manual ? 'manual_pending' : 'queued'
      if (scheduledAt) {
        const mode = plan.manual ? 'local' : (fields.scheduleMode ?? (connector.supportsPlatformScheduling ? 'platform' : 'local'))
        fields.scheduleMode = mode === 'platform' && connector.supportsPlatformScheduling ? 'platform' : 'local'
        // Platform scheduling uploads right away; local scheduling waits for the time.
        status = fields.scheduleMode === 'platform' ? 'queued' : 'scheduled'
      } else {
        delete fields.scheduleMode
      }
      const publication = this.options.publications.create({
        contentId: versionRecord.contentId,
        versionId: versionRecord.id,
        accountId: plan.account.id,
        title: plan.destination.title,
        caption: plan.destination.caption,
        hashtags: plan.destination.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)),
        fields,
        status,
        idempotencyKey: plan.key,
        scheduledAt
      })
      created.push(publication)
      this.emit({ type: 'publication', publication })
      if (status === 'queued') this.enqueue(publication.id)
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
    if (this.onPlatform(publication)) {
      throw new ConflictError('Esse vídeo já está no YouTube, agendado como privado. Cancele ou apague no YouTube Studio.')
    }
    if (!['queued', 'manual_pending', 'failed', 'scheduled', 'draft'].includes(publication.status)) {
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
  /* Scheduling                                                       */
  /* ---------------------------------------------------------------- */

  /** True when the platform already holds the post for its scheduled time (can't be changed from here). */
  private onPlatform(p: Publication): boolean {
    return p.status === 'scheduled' && p.fields.scheduleMode === 'platform' && p.externalPostId !== null
  }

  /**
   * Runs due schedules. A local schedule runs if it is at most `graceMinutes` late;
   * later than that (the computer was off) it is flagged as missed and waits for the user,
   * so nothing is ever published silently at an unexpected time.
   */
  tick(): void {
    const now = this.now()
    const grace = (this.options.graceMinutes?.() ?? 15) * 60_000
    for (const p of this.options.publications.due(new Date(now).toISOString())) {
      if (this.onPlatform(p)) {
        const live = this.options.publications.markLiveAt(p.id, p.scheduledAt!)
        this.emit({ type: 'publication', publication: live })
        continue
      }
      if (p.fields.missed) continue
      const account = this.options.accounts.find(p.accountId)
      if (!account) continue
      const late = now - new Date(p.scheduledAt!).getTime()
      if (late > grace) {
        const flagged = this.options.publications.updateFields(p.id, { missed: true })
        this.emit({ type: 'publication', publication: flagged })
        this.options.notify?.('Horário perdido', `${account.displayName}: a publicação de ${formatTime(p.scheduledAt!)} não foi feita porque o app estava fechado. Abra a Fila para publicar ou reagendar.`)
        continue
      }
      const manual = account.manual || !this.options.connectors[account.platformId].publish
      const to = manual ? 'manual_pending' : 'queued'
      if (!this.options.publications.transition(p.id, 'scheduled', to)) continue
      const updated = this.options.publications.get(p.id)
      this.emit({ type: 'publication', publication: updated })
      if (manual) this.options.notify?.('Hora de publicar', `${account.displayName}: “${p.title ?? 'publicação'}” está pronta para você publicar.`)
      else this.enqueue(p.id)
    }
  }

  reschedule(id: string, scheduledAtInput: string): Publication {
    const p = this.options.publications.get(id)
    const at = new Date(scheduledAtInput)
    if (at.getTime() <= this.now() + 30_000) throw new UnprocessableError('Escolha um horário no futuro.')
    if (this.onPlatform(p)) throw new ConflictError('Esse vídeo já está agendado no YouTube. Mude o horário no YouTube Studio.')
    if (!['scheduled', 'draft', 'manual_pending', 'failed', 'cancelled'].includes(p.status)) {
      throw new ConflictError('Essa publicação não pode mais ser reagendada.')
    }
    const repo = this.options.publications
    repo.setSchedule(id, at.toISOString())
    const account = this.options.accounts.record(p.accountId)
    const connector = this.options.connectors[account.platformId]
    const manual = account.manual || !connector.publish
    const mode = manual ? 'local' : (p.fields.scheduleMode ?? (connector.supportsPlatformScheduling ? 'platform' : 'local'))
    repo.updateFields(id, { missed: undefined, scheduleMode: mode })
    let updated: Publication
    if (p.status === 'draft') {
      updated = repo.get(id) // stays paused, with the new time
    } else if (mode === 'platform') {
      updated = repo.setStatus(id, 'queued')
      this.enqueue(id)
    } else {
      updated = repo.setStatus(id, 'scheduled')
    }
    this.emit({ type: 'publication', publication: updated })
    return updated
  }

  publishNow(id: string): Publication {
    const p = this.options.publications.get(id)
    if (!['scheduled', 'draft'].includes(p.status) || this.onPlatform(p)) {
      throw new ConflictError('Só é possível publicar agora uma publicação agendada ou pausada que ainda não foi enviada.')
    }
    const repo = this.options.publications
    const account = this.options.accounts.record(p.accountId)
    const manual = account.manual || !this.options.connectors[account.platformId].publish
    if (!manual && account.connectionStatus !== 'connected') throw new ConflictError(`A conta ${account.displayName} não está conectada. Reconecte-a em Contas.`)
    repo.setSchedule(id, null)
    repo.updateFields(id, { missed: undefined, paused: undefined, scheduleMode: undefined })
    const updated = repo.setStatus(id, manual ? 'manual_pending' : 'queued')
    this.emit({ type: 'publication', publication: updated })
    if (!manual) this.enqueue(id)
    return updated
  }

  pause(id: string): Publication {
    const p = this.options.publications.get(id)
    if (p.status !== 'scheduled' || this.onPlatform(p)) throw new ConflictError('Só é possível pausar uma publicação agendada que ainda não foi enviada.')
    if (!this.options.publications.transition(id, 'scheduled', 'draft')) throw new ConflictError('A publicação mudou de estado. Atualize e tente de novo.')
    const updated = this.options.publications.updateFields(id, { paused: true })
    this.emit({ type: 'publication', publication: updated })
    return updated
  }

  resume(id: string): Publication {
    const p = this.options.publications.get(id)
    if (p.status !== 'draft') throw new ConflictError('Essa publicação não está pausada.')
    if (!p.scheduledAt || new Date(p.scheduledAt).getTime() <= this.now() + 30_000) {
      throw new UnprocessableError('O horário dessa publicação já passou. Escolha um novo horário ou publique agora.')
    }
    this.options.publications.transition(id, 'draft', 'scheduled')
    const updated = this.options.publications.updateFields(id, { paused: undefined })
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
      publication = result.scheduledOnPlatform ? repo.markUploadedScheduled(id, result) : repo.markPublished(id, result)
      this.options.logger.info(result.scheduledOnPlatform ? 'Uploaded, scheduled on platform' : 'Published', {
        id,
        account: account.id,
        post: result.externalPostId
      })
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

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso))
}

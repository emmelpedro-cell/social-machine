import type {
  AnalyticsOverview,
  ContentAnalytics,
  ManualMetricsInput,
  MetricSnapshot,
  RefreshResult
} from '../../shared/analytics'
import type { PlatformId } from '../../shared/publishing'
import { ConflictError, UnprocessableError } from '../errors'
import type { Logger } from '../logger'
import type { AccountsRepository } from '../repositories/accounts'
import type { MetricsRepository } from '../repositories/metrics'
import type { PublicationsRepository } from '../repositories/publications'
import { ReauthorizeError, type Connector } from '../connectors/types'

export type MetricsEvent = { type: 'metrics' }

export type MetricsServiceOptions = {
  metrics: MetricsRepository
  accounts: AccountsRepository
  publications: PublicationsRepository
  connectors: Record<PlatformId, Connector>
  logger: Logger
  emit: (event: MetricsEvent) => void
  now?: () => number
  /** How often to look for publications due a new snapshot; 0 disables the timer (tests). */
  tickMs?: number
}

const HOUR = 3_600_000

/**
 * How often a publication gets a new snapshot, by age: frequent in the first
 * days (when numbers move), rare later. Keeps API use low (one videos.list
 * call covers 50 videos) while giving the 24 h / 7 d / 30 d marks.
 */
export function snapshotInterval(ageMs: number): number {
  if (ageMs < 2 * 24 * HOUR) return 3 * HOUR
  if (ageMs < 30 * 24 * HOUR) return 12 * HOUR
  if (ageMs < 180 * 24 * HOUR) return 72 * HOUR
  return 14 * 24 * HOUR
}

/** Collects metric snapshots from the platforms' APIs and records numbers typed in by the user. */
export class MetricsService {
  private readonly now: () => number
  private timer: NodeJS.Timeout | null = null
  private readonly running = new Set<string>()

  constructor(private readonly options: MetricsServiceOptions) {
    this.now = options.now ?? Date.now
  }

  private automatic(platformId: PlatformId, manual: boolean): boolean {
    return !manual && Boolean(this.options.connectors[platformId].collectMetrics)
  }

  start(): void {
    const interval = this.options.tickMs ?? 10 * 60_000
    // First pass shortly after start, so launching the app isn't slowed down.
    const first = setTimeout(() => void this.collectDue().catch(() => undefined), Math.min(interval, 30_000))
    first.unref?.()
    if (interval > 0) {
      this.timer = setInterval(() => void this.collectDue().catch(() => undefined), interval)
      this.timer.unref?.()
    }
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Collects for publications whose last snapshot is older than their interval. */
  async collectDue(): Promise<RefreshResult> {
    const now = this.now()
    const due = this.options.metrics
      .collectable()
      .filter((p) => !p.lastCapture || now - new Date(p.lastCapture).getTime() >= snapshotInterval(now - new Date(p.publishedAt).getTime()))
    return this.collect(due)
  }

  /** Collects now for every collectable publication (of one account, or all). */
  async refresh(accountId?: string): Promise<RefreshResult> {
    if (accountId) {
      const account = this.options.accounts.record(accountId)
      if (!this.automatic(account.platformId, account.manual)) {
        throw new ConflictError('Essa conta não tem métricas automáticas. Informe os números da plataforma na página do conteúdo.')
      }
      if (account.connectionStatus !== 'connected') throw new ConflictError(`A conta ${account.displayName} não está conectada. Reconecte-a em Contas.`)
    }
    const items = this.options.metrics.collectable(accountId)
    const result = await this.collect(items)
    // Accounts without published videos still get their follower count.
    if (accountId && items.length === 0) await this.collectAccount(accountId, [], result)
    return result
  }

  private async collect(items: ReturnType<MetricsRepository['collectable']>): Promise<RefreshResult> {
    const result: RefreshResult = { accounts: 0, publications: 0, errors: [] }
    const byAccount = new Map<string, typeof items>()
    for (const item of items) byAccount.set(item.accountId, [...(byAccount.get(item.accountId) ?? []), item])
    for (const [accountId, list] of byAccount) await this.collectAccount(accountId, list, result)
    if (result.accounts > 0) this.emit()
    return result
  }

  private async collectAccount(accountId: string, list: ReturnType<MetricsRepository['collectable']>, result: RefreshResult): Promise<void> {
    if (this.running.has(accountId)) return
    this.running.add(accountId)
    const account = this.options.accounts.record(accountId)
    try {
      const connector = this.options.connectors[account.platformId]
      if (!connector.collectMetrics) return
      const collected = await connector.collectMetrics(
        account,
        list.map((p) => ({ publicationId: p.id, externalPostId: p.externalPostId, publishedAt: p.publishedAt }))
      )
      const at = new Date(this.now()).toISOString()
      for (const [publicationId, values] of collected.publications) {
        this.options.metrics.insert(publicationId, at, values, 'api')
        result.publications++
      }
      if (collected.account) this.options.metrics.insertAccount(accountId, at, collected.account)
      const missing = list.length - collected.publications.size
      const notes = [collected.warning, missing > 0 ? `${missing} vídeo(s) não foram encontrados no YouTube (apagados ou indisponíveis).` : null].filter(Boolean)
      this.options.metrics.setCollectionStatus(accountId, notes.length ? notes.join(' ') : null)
      if (collected.warning) result.errors.push(`${account.displayName}: ${collected.warning}`)
      result.accounts++
      this.options.logger.info('Metrics collected', { account: accountId, publications: collected.publications.size, warning: collected.warning })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.options.metrics.setCollectionStatus(accountId, message)
      result.errors.push(`${account.displayName}: ${message}`)
      result.accounts++
      this.options.logger.warn('Metrics collection failed', { account: accountId, error })
      if (error instanceof ReauthorizeError) this.options.logger.info('Account needs reconnecting for metrics', { account: accountId })
    } finally {
      this.running.delete(accountId)
    }
  }

  /** Numbers the user read in the platform's own app (TikTok, Instagram), saved as "informado por você". */
  addManual(input: ManualMetricsInput): MetricSnapshot {
    const publication = this.options.publications.get(input.publicationId)
    if (publication.status !== 'published' || !publication.publishedAt) throw new ConflictError('Só dá para registrar métricas de uma publicação publicada.')
    const account = this.options.accounts.record(publication.accountId)
    if (this.automatic(account.platformId, account.manual)) {
      throw new ConflictError('As métricas dessa conta vêm da API automaticamente; não é possível digitá-las.')
    }
    const at = new Date(input.capturedAt)
    if (at.getTime() > this.now() + 5 * 60_000) throw new UnprocessableError('A data da medição não pode estar no futuro.')
    if (at.getTime() < new Date(publication.publishedAt).getTime() - 60_000) throw new UnprocessableError('A data da medição é anterior à publicação.')
    const values = [input.views, input.likes, input.comments, input.shares, input.followersGained, input.watchTimeSeconds, input.averageViewDurationSeconds]
    if (values.every((v) => v === null || v === undefined)) throw new UnprocessableError('Preencha pelo menos um número.')
    const snapshot = this.options.metrics.insert(
      publication.id,
      at.toISOString(),
      {
        views: input.views ?? null,
        likes: input.likes ?? null,
        comments: input.comments ?? null,
        shares: input.shares ?? null,
        followersGained: input.followersGained ?? null,
        watchTimeSeconds: input.watchTimeSeconds ?? null,
        averageViewDurationSeconds: input.averageViewDurationSeconds ?? null,
        extra: {}
      },
      'manual'
    )
    this.emit()
    return snapshot
  }

  deleteManual(id: string): void {
    this.options.metrics.deleteManual(id)
    this.emit()
  }

  overview(): AnalyticsOverview {
    return {
      rows: this.options.metrics.performance(),
      accounts: this.options.metrics.accounts((p, manual) => this.automatic(p, manual))
    }
  }

  content(contentId: string): ContentAnalytics {
    const rows = this.options.metrics.performance({ contentId })
    return { rows, history: this.options.metrics.history(rows.map((r) => r.publicationId)) }
  }

  private emit(): void {
    try {
      this.options.emit({ type: 'metrics' })
    } catch (error) {
      this.options.logger.warn('Metrics event delivery failed', { error })
    }
  }
}

import type { MetricValues } from '../../shared/analytics'
import type { Account, DestinationInput, PlatformInfo, Publication, PublicationFields } from '../../shared/publishing'
import type { AccountRecord } from '../repositories/accounts'

export type PublishableVersion = {
  filePath: string
  fileSize: number
  width: number
  height: number
  durationSeconds: number
}

export type PublishContext = {
  publication: Publication
  account: AccountRecord
  version: PublishableVersion
  onProgress: (fraction: number) => void
  /** Persists connector state (e.g. a resumable upload session) so a later attempt can continue. */
  saveFields: (patch: Partial<PublicationFields>) => void
  signal: AbortSignal
}

export type PublishResult = {
  externalPostId: string | null
  externalUrl: string | null
  /** The platform holds the post and publishes it at the scheduled time. */
  scheduledOnPlatform?: boolean
}

export type MetricsRequest = { publicationId: string; externalPostId: string; publishedAt: string }

export type CollectedMetrics = {
  /** Values per publication id; publications the platform didn't return are absent. */
  publications: Map<string, MetricValues>
  account: { followers: number | null; totalViews: number | null; videoCount: number | null } | null
  /** Partial failure worth showing (e.g. the Analytics API isn't enabled); the rest was collected. */
  warning: string | null
}

/** A comment as the platform reports it. */
export type ExternalComment = {
  externalId: string
  /** Top-level comment id the reply belongs to (its own id for a top-level comment). */
  threadId: string
  type: 'comment' | 'reply'
  videoId: string | null
  text: string
  author: string | null
  authorUrl: string | null
  /** True when written by the connected account itself. */
  own: boolean
  createdAt: string
  updatedAt: string | null
  likeCount: number | null
  canReply: boolean
}

export type InboxCapabilities = { readComments: boolean; reply: boolean; limitation: string | null }

/**
 * One module per platform. Capabilities differ: the UI asks `info()` before
 * offering an action, and optional methods exist only where the platform's
 * official API allows them.
 */
export interface Connector {
  info(): PlatformInfo
  /** Problems that block publishing this version with these fields. */
  validate(version: PublishableVersion, destination: DestinationInput): string[]
  /** Non-blocking remarks (e.g. "will be a Short"). */
  notes(version: PublishableVersion): string[]
  connect?(projectIds: string[]): Promise<Account>
  disconnect?(account: AccountRecord): Promise<void>
  publish?(context: PublishContext): Promise<PublishResult>
  /** Reads metrics of published posts through the official API. */
  collectMetrics?(account: AccountRecord, items: readonly MetricsRequest[]): Promise<CollectedMetrics>
  /** What the inbox can do for this account (depends on the platform and the permissions granted). */
  inboxCapabilities?(account: AccountRecord): InboxCapabilities
  /** Recent comments, newest first; stops paging once it reaches comments older than `knownUntil`. */
  fetchComments?(account: AccountRecord, options: { knownUntil: string | null; maxPages: number }): Promise<ExternalComment[]>
  /** Sends a reply written by the user. */
  replyToComment?(account: AccountRecord, threadId: string, text: string): Promise<ExternalComment>
  /** Whether the platform can publish at a set time by itself (no app or computer needed then). */
  supportsPlatformScheduling?: boolean
}

/** The access to an account was lost; the user must connect it again. */
export class ReauthorizeError extends Error {
  override name = 'ReauthorizeError'
}

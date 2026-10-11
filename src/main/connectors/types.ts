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
  /** Whether the platform can publish at a set time by itself (no app or computer needed then). */
  supportsPlatformScheduling?: boolean
}

/** The access to an account was lost; the user must connect it again. */
export class ReauthorizeError extends Error {
  override name = 'ReauthorizeError'
}

import { z } from 'zod'
import type { PlatformId } from './publishing'

/**
 * Inbox (Phase 6): comments from the platforms that allow reading them
 * through their official API. Replies are always written and sent by the
 * user — nothing is answered automatically.
 */

export type InboxItemType = 'comment' | 'reply'
export type ReadStatus = 'unread' | 'read'
export type ResponseStatus = 'none' | 'resolved' | 'replied'

export type InboxItem = {
  id: string
  accountId: string
  accountName: string
  platformId: PlatformId
  type: InboxItemType
  /** Groups a top-level comment with its replies. */
  threadId: string | null
  text: string
  author: string | null
  authorUrl: string | null
  createdAt: string
  receivedAt: string
  likeCount: number | null
  canReply: boolean
  /** Written by the account itself (e.g. a reply sent from the app). */
  own: boolean
  readStatus: ReadStatus
  responseStatus: ResponseStatus
  /** The publication made from this app, when the comment is on one of them. */
  publicationId: string | null
  contentId: string | null
  contentName: string | null
  projectId: string | null
  /** Video title (from the publication) or the platform's id when the video wasn't published from the app. */
  videoTitle: string | null
  externalVideoId: string | null
  /** Link to the comment on the platform. */
  url: string | null
}

/** What each account's inbox can do, and how the last sync went. */
export type InboxAccountStatus = {
  accountId: string
  accountName: string
  platformId: PlatformId
  readComments: boolean
  reply: boolean
  /** Why reading or replying isn't available (shown in the UI). */
  limitation: string | null
  checkedAt: string | null
  error: string | null
  unread: number
}

export type InboxSyncResult = { accounts: number; newItems: number; errors: string[] }

export const InboxIdsInputSchema = z
  .object({ ids: z.array(z.string().uuid('Item inválido')).min(1).max(5000), value: z.boolean() })
  .strict()

export const InboxReplyInputSchema = z
  .object({
    id: z.string().uuid('Item inválido'),
    text: z.string().trim().min(1, 'Escreva a resposta.').max(10_000, 'Resposta longa demais.')
  })
  .strict()

export const InboxItemIdInputSchema = z.object({ id: z.string().uuid('Item inválido') }).strict()

export const InboxSyncInputSchema = z.object({ accountId: z.string().uuid('Conta inválida').optional() }).strict()

/** Link to a YouTube comment (opens the video with the comment highlighted). */
export function youtubeCommentUrl(videoId: string | null, commentId: string): string | null {
  return videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&lc=${encodeURIComponent(commentId)}` : null
}

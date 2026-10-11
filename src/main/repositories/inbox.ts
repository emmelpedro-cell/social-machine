import { randomUUID } from 'node:crypto'
import type { SqlDriver } from '../db/driver'
import { transaction } from '../db/driver'
import { NotFoundError } from '../errors'
import { youtubeCommentUrl, type InboxItem, type ReadStatus, type ResponseStatus } from '../../shared/inbox'
import type { PlatformId } from '../../shared/publishing'
import type { ExternalComment } from '../connectors/types'

type Row = {
  id: string
  account_id: string
  account_name: string
  platform_id: PlatformId
  publication_id: string | null
  external_item_id: string
  item_type: 'comment' | 'reply'
  thread_id: string | null
  text: string | null
  author: string | null
  author_url: string | null
  external_created_at: string | null
  received_at: string
  like_count: number | null
  can_reply: number
  is_own: number
  read_status: ReadStatus
  response_status: ResponseStatus
  external_video_id: string | null
  content_id: string | null
  content_name: string | null
  project_id: string | null
  publication_title: string | null
}

const SELECT = `SELECT i.id, i.account_id, a.display_name AS account_name, a.platform_id, i.publication_id, i.external_item_id, i.item_type,
    i.thread_id, i.text, i.author, i.author_url, i.external_created_at, i.received_at, i.like_count, i.can_reply, i.is_own,
    i.read_status, i.response_status, i.external_video_id, p.content_id, COALESCE(c.title, c.file_name) AS content_name,
    c.project_id, p.title AS publication_title
  FROM inbox_items i
  JOIN accounts a ON a.id = i.account_id
  LEFT JOIN publications p ON p.id = i.publication_id
  LEFT JOIN contents c ON c.id = p.content_id`

function toItem(r: Row): InboxItem {
  return {
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    platformId: r.platform_id,
    type: r.item_type,
    threadId: r.thread_id,
    text: r.text ?? '',
    author: r.author,
    authorUrl: r.author_url,
    createdAt: r.external_created_at ?? r.received_at,
    receivedAt: r.received_at,
    likeCount: r.like_count === null ? null : Number(r.like_count),
    canReply: Number(r.can_reply) === 1,
    own: Number(r.is_own) === 1,
    readStatus: r.read_status,
    responseStatus: r.response_status,
    publicationId: r.publication_id,
    contentId: r.content_id,
    contentName: r.content_name,
    projectId: r.project_id,
    videoTitle: r.publication_title,
    externalVideoId: r.external_video_id,
    url: r.platform_id === 'youtube' ? youtubeCommentUrl(r.external_video_id, r.external_item_id) : null
  }
}

/** Comments per account; each platform id is stored once (UNIQUE account + external id). */
export class InboxRepository {
  constructor(
    private readonly db: SqlDriver,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = randomUUID
  ) {}

  list(limit = 3000): InboxItem[] {
    return (this.db.prepare(`${SELECT} ORDER BY COALESCE(i.external_created_at, i.received_at) DESC LIMIT ?`).all(limit) as Row[]).map(toItem)
  }

  get(id: string): InboxItem {
    const row = this.db.prepare(`${SELECT} WHERE i.id = ?`).get(id) as Row | undefined
    if (!row) throw new NotFoundError('Esse comentário não existe mais.')
    return toItem(row)
  }

  /** Newest comment time already stored for the account (to stop paging at known comments). */
  newest(accountId: string): string | null {
    const row = this.db
      .prepare(`SELECT MAX(COALESCE(updated_at, external_created_at)) AS at FROM inbox_items WHERE account_id = ? AND is_own = 0`)
      .get(accountId) as { at: string | null } | undefined
    return row?.at ?? null
  }

  hasAny(accountId: string): boolean {
    return this.db.prepare('SELECT 1 FROM inbox_items WHERE account_id = ? LIMIT 1').get(accountId) !== undefined
  }

  /**
   * Inserts new comments and refreshes text/likes of known ones (keeping read and
   * response status). Returns the ids of comments that were new.
   * `markReadBefore`: new comments older than this are stored as already read (first sync backlog).
   */
  upsert(
    accountId: string,
    comments: readonly ExternalComment[],
    publicationByVideo: (videoId: string) => string | null,
    markReadBefore: string | null
  ): string[] {
    return transaction(this.db, () => {
      const created: string[] = []
      const find = this.db.prepare('SELECT id FROM inbox_items WHERE account_id = ? AND external_item_id = ?')
      const update = this.db.prepare(
        'UPDATE inbox_items SET text = ?, like_count = ?, can_reply = ?, updated_at = ?, author = ?, author_url = ? WHERE id = ?'
      )
      const insert = this.db.prepare(
        `INSERT INTO inbox_items (id, account_id, publication_id, external_item_id, item_type, text, author, external_created_at, received_at,
           read_status, response_status, thread_id, external_video_id, author_url, like_count, can_reply, is_own, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const c of comments) {
        const existing = find.get(accountId, c.externalId) as { id: string } | undefined
        if (existing) {
          update.run(c.text, c.likeCount, c.canReply ? 1 : 0, c.updatedAt, c.author, c.authorUrl, existing.id)
          continue
        }
        const id = this.newId()
        const read = c.own || (markReadBefore !== null && c.createdAt < markReadBefore)
        insert.run(
          id,
          accountId,
          c.videoId ? publicationByVideo(c.videoId) : null,
          c.externalId,
          c.type,
          c.text,
          c.author,
          c.createdAt,
          this.now(),
          read ? 'read' : 'unread',
          c.threadId,
          c.videoId,
          c.authorUrl,
          c.likeCount,
          c.canReply ? 1 : 0,
          c.own ? 1 : 0,
          c.updatedAt
        )
        if (!read) created.push(id)
      }
      return created
    })
  }

  setRead(ids: readonly string[], read: boolean): void {
    this.updateMany(ids, 'read_status = ?', read ? 'read' : 'unread')
  }

  setResolved(ids: readonly string[], resolved: boolean): void {
    // Un-resolving a replied comment keeps "replied".
    const marks = ids.map(() => '?').join(', ')
    if (resolved) {
      this.db.prepare(`UPDATE inbox_items SET response_status = 'resolved', read_status = 'read' WHERE id IN (${marks}) AND response_status = 'none'`).run(...ids)
    } else {
      this.db.prepare(`UPDATE inbox_items SET response_status = 'none' WHERE id IN (${marks}) AND response_status = 'resolved'`).run(...ids)
    }
  }

  markReplied(id: string): void {
    this.db.prepare(`UPDATE inbox_items SET response_status = 'replied', read_status = 'read' WHERE id = ?`).run(id)
  }

  private updateMany(ids: readonly string[], set: string, value: string): void {
    const marks = ids.map(() => '?').join(', ')
    this.db.prepare(`UPDATE inbox_items SET ${set} WHERE id IN (${marks})`).run(value, ...ids)
  }

  unreadByAccount(): Map<string, number> {
    const rows = this.db
      .prepare(`SELECT account_id, COUNT(*) AS n FROM inbox_items WHERE read_status = 'unread' GROUP BY account_id`)
      .all() as { account_id: string; n: number }[]
    return new Map(rows.map((r) => [r.account_id, Number(r.n)]))
  }

  setSyncStatus(accountId: string, error: string | null): void {
    this.db.prepare('UPDATE accounts SET inbox_checked_at = ?, inbox_error = ? WHERE id = ?').run(this.now(), error, accountId)
  }

  syncStatus(accountId: string): { checkedAt: string | null; error: string | null } {
    const row = this.db.prepare('SELECT inbox_checked_at, inbox_error FROM accounts WHERE id = ?').get(accountId) as
      | { inbox_checked_at: string | null; inbox_error: string | null }
      | undefined
    return { checkedAt: row?.inbox_checked_at ?? null, error: row?.inbox_error ?? null }
  }

  /** Publication of this account whose platform post id is `videoId`. */
  publicationForVideo(accountId: string, videoId: string): string | null {
    const row = this.db
      .prepare(`SELECT id FROM publications WHERE account_id = ? AND external_post_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(accountId, videoId) as { id: string } | undefined
    return row?.id ?? null
  }
}

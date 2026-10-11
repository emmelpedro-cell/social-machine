import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { runMigrations } from '../../src/main/db/migrations'
import type { SqlDriver } from '../../src/main/db/driver'
import { InboxService } from '../../src/main/inbox/inbox-service'
import { YouTubeClientConfig } from '../../src/main/connectors/config'
import { ManualConnector } from '../../src/main/connectors/manual'
import { YouTubeConnector } from '../../src/main/connectors/youtube/connector'
import { AccountsRepository } from '../../src/main/repositories/accounts'
import { ContentsRepository } from '../../src/main/repositories/contents'
import { InboxRepository } from '../../src/main/repositories/inbox'
import { PublicationsRepository } from '../../src/main/repositories/publications'
import { MemorySecretStore } from '../../src/main/secrets/token-store'
import { FakeGoogle, type FakeComment } from '../helpers/fake-google'
import { createNodeSqliteDriver, memoryLogger } from '../helpers/node-sqlite-driver'

const DAY = 86_400_000

describe('inbox', () => {
  let google: FakeGoogle
  let db: SqlDriver
  let accounts: AccountsRepository
  let publications: PublicationsRepository
  let inboxRepo: InboxRepository
  let youtube: YouTubeConnector
  let service: InboxService
  let notices: string[]
  let events: number
  let clock: number

  const comment = (id: string, text: string, ageMs: number, author = 'Fã', authorChannelId = 'UCfan'): FakeComment => ({
    id,
    text,
    author,
    authorChannelId,
    publishedAt: new Date(clock - ageMs).toISOString()
  })

  beforeEach(async () => {
    google = new FakeGoogle()
    await google.start()
    db = createNodeSqliteDriver()
    runMigrations(db)
    const secrets = new MemorySecretStore()
    accounts = new AccountsRepository(db)
    publications = new PublicationsRepository(db)
    inboxRepo = new InboxRepository(db)
    const config = new YouTubeClientConfig(db, secrets)
    config.set({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'x' })
    clock = Date.now()
    notices = []
    events = 0
    youtube = new YouTubeConnector({
      accounts,
      secrets,
      config,
      fetch: (url, init) => fetch(url, init),
      openBrowser: google.approve,
      logger: memoryLogger(),
      endpoints: google.endpoints
    })
    service = new InboxService({
      inbox: inboxRepo,
      accounts,
      connectors: { youtube, tiktok: new ManualConnector('tiktok'), instagram: new ManualConnector('instagram') },
      logger: memoryLogger(),
      emit: () => events++,
      notify: (title) => notices.push(title),
      now: () => clock,
      tickMs: 0,
      maxPages: 3
    })
  })

  afterEach(async () => {
    service.shutdown()
    await google.stop()
    db.close()
  })

  it('collects comments and replies from the channel, linking them to publications made in the app', async () => {
    const account = await youtube.connect([])
    const contentId = new ContentsRepository(db).insertPending({ path: '/a.mp4', pathKey: '/a.mp4', size: 1, mtimeMs: 1 })!.id
    const p = publications.create({ contentId, versionId: null as never, accountId: account.id, title: 'Nocaute', caption: null, hashtags: [], fields: {}, status: 'publishing', idempotencyKey: randomUUID() })
    publications.markPublished(p.id, { externalPostId: 'vidA', externalUrl: null })

    google.threads.push(
      { id: 'c1', videoId: 'vidA', canReply: true, top: comment('c1', 'Qual o nome desse lutador?', 2 * 3_600_000), replies: [comment('c1.r1', 'É o Silva!', 3_600_000, 'Outro', 'UCother')] },
      { id: 'c2', videoId: 'vidOther', canReply: false, top: comment('c2', 'Antigo', 30 * DAY), replies: [] }
    )
    const result = await service.sync()
    expect(result).toEqual({ accounts: 1, newItems: 2, errors: [] })
    expect(notices).toEqual([]) // first sync: no notification
    const items = service.list()
    expect(items).toHaveLength(3)
    const c1 = items.find((i) => i.text === 'Qual o nome desse lutador?')!
    expect(c1).toMatchObject({ type: 'comment', threadId: 'c1', author: 'Fã', readStatus: 'unread', publicationId: p.id, contentId, videoTitle: 'Nocaute', canReply: true })
    expect(c1.url).toBe('https://www.youtube.com/watch?v=vidA&lc=c1')
    expect(items.find((i) => i.text === 'É o Silva!')).toMatchObject({ type: 'reply', threadId: 'c1', readStatus: 'unread' })
    // Old backlog on first sync is history (already read); not linked to an app publication.
    expect(items.find((i) => i.text === 'Antigo')).toMatchObject({ readStatus: 'read', publicationId: null, canReply: false })

    // Next sync: only new things are new; text edits update in place; a desktop notification.
    google.threads[0]!.top.text = 'Qual o nome desse lutador??'
    google.threads.push({ id: 'c3', videoId: 'vidA', canReply: true, top: comment('c3', 'Golpe absurdo', -1000), replies: [] })
    const second = await service.sync()
    expect(second.newItems).toBe(1)
    expect(notices).toEqual(['Novo comentário'])
    expect(service.list()).toHaveLength(4)
    expect(service.list().find((i) => i.threadId === 'c1' && i.type === 'comment')!.text).toBe('Qual o nome desse lutador??')
    expect(service.status().find((s) => s.accountId === account.id)).toMatchObject({ readComments: true, reply: true, unread: 3, error: null })
  })

  it('pages through many threads and stops at comments it already has', async () => {
    await youtube.connect([])
    for (let i = 0; i < 250; i++) google.threads.push({ id: `t${i}`, videoId: 'v', canReply: true, top: comment(`t${i}`, `#${i}`, (i + 1) * 60_000), replies: [] })
    await service.sync()
    expect(service.list()).toHaveLength(250)
    const before = google.requests.filter((r) => r.endsWith('/commentThreads')).length
    google.threads.push({ id: 'new', videoId: 'v', canReply: true, top: comment('new', 'novo', -1000), replies: [] })
    await service.sync()
    const after = google.requests.filter((r) => r.endsWith('/commentThreads')).length
    expect(after - before).toBe(1) // first page already reaches known comments
    expect(service.list()).toHaveLength(251)
  })

  it('marks read, resolved and sends replies the user wrote — once', async () => {
    const account = await youtube.connect([])
    google.threads.push({ id: 'c1', videoId: 'vidA', canReply: true, top: comment('c1', 'Qual o modelo do skate?', 3_600_000), replies: [] })
    await service.sync()
    const item = service.list()[0]!

    service.setRead([item.id], true)
    expect(service.list()[0]!.readStatus).toBe('read')
    service.setRead([item.id], false)
    service.setResolved([item.id], true)
    expect(service.list()[0]).toMatchObject({ responseStatus: 'resolved', readStatus: 'read' })
    service.setResolved([item.id], false)
    expect(service.list()[0]!.responseStatus).toBe('none')

    const [first, second] = await Promise.allSettled([service.reply(item.id, 'É um Element 8.0!'), service.reply(item.id, 'É um Element 8.0!')])
    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('rejected')
    expect(google.insertedReplies).toEqual([{ parentId: 'c1', text: 'É um Element 8.0!' }])
    const thread = service.list().filter((i) => i.threadId === 'c1')
    expect(thread.find((i) => i.id === item.id)).toMatchObject({ responseStatus: 'replied', readStatus: 'read' })
    expect(thread.find((i) => i.own)).toMatchObject({ type: 'reply', text: 'É um Element 8.0!', readStatus: 'read' })
    // The reply comes back on the next sync without duplicating.
    await service.sync()
    expect(service.list().filter((i) => i.threadId === 'c1')).toHaveLength(2)
    expect(service.status().find((s) => s.accountId === account.id)!.unread).toBe(0)

    google.failNextReply = true
    await expect(service.reply(item.id, 'x'.repeat(20))).rejects.toThrow(/longa demais/)
  })

  it('explains when the login lacks the permission to reply, and when comments are not available at all', async () => {
    google.grantScopes = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly'
    const account = await youtube.connect([])
    google.threads.push({ id: 'c1', videoId: 'vidA', canReply: true, top: comment('c1', 'Oi', 1000), replies: [] })
    await service.sync()
    const status = service.status().find((s) => s.accountId === account.id)!
    expect(status).toMatchObject({ readComments: true, reply: false })
    expect(status.limitation).toMatch(/reconecte/i)
    await expect(service.reply(service.list()[0]!.id, 'Oi!')).rejects.toThrow(/reconecte/i)
    expect(google.insertedReplies).toEqual([])

    const tiktok = accounts.addManual({ platformId: 'tiktok', displayName: '@x', projectIds: [] })
    expect(service.status().find((s) => s.accountId === tiktok.id)).toMatchObject({ readComments: false, reply: false, limitation: expect.stringMatching(/app aprovado/) })
    await expect(service.sync(tiktok.id)).rejects.toThrow(/não oferece comentários/)
  })

  it('records sync errors per account', async () => {
    const account = await youtube.connect([])
    google.invalidateAccessTokens()
    google.refreshFails = true
    const result = await service.sync()
    expect(result.errors).toHaveLength(1)
    expect(accounts.get(account.id).connectionStatus).toBe('expired')
    expect(service.status()[0]!.error).toBeTruthy()
    expect(service.status()[0]!.readComments).toBe(false)
  })
})

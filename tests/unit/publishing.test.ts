import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runMigrations } from '../../src/main/db/migrations'
import type { SqlDriver } from '../../src/main/db/driver'
import { YouTubeClientConfig } from '../../src/main/connectors/config'
import { ManualConnector } from '../../src/main/connectors/manual'
import { YouTubeConnector } from '../../src/main/connectors/youtube/connector'
import { sanitizeMetadata } from '../../src/main/connectors/youtube/api'
import { OAuthError, type StoredTokens } from '../../src/main/connectors/youtube/oauth'
import { PublishService } from '../../src/main/publishing/publish-service'
import { AccountsRepository } from '../../src/main/repositories/accounts'
import { ContentsRepository } from '../../src/main/repositories/contents'
import { ProjectsRepository } from '../../src/main/repositories/projects'
import { PublicationsRepository } from '../../src/main/repositories/publications'
import { VersionsRepository } from '../../src/main/repositories/versions'
import { FileSecretStore, MemorySecretStore } from '../../src/main/secrets/token-store'
import { defaultEditSettings } from '../../src/shared/editor'
import { composeCaption, type DestinationInput, type PublicationEvent } from '../../src/shared/publishing'
import { CreateProjectInputSchema } from '../../src/shared/schemas'
import { FakeGoogle } from '../helpers/fake-google'
import { createNodeSqliteDriver, memoryLogger, tempDir } from '../helpers/node-sqlite-driver'

const CLIENT = { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-test' }

describe('publishing', () => {
  const root = tempDir('sm-publish-')
  let google: FakeGoogle
  let db: SqlDriver
  let secrets: MemorySecretStore
  let accounts: AccountsRepository
  let publications: PublicationsRepository
  let versions: VersionsRepository
  let projects: ProjectsRepository
  let youtube: YouTubeConnector
  let service: PublishService
  let events: PublicationEvent[]
  let videoFile: string
  let versionId: string
  let contentId: string
  let openBrowser: (url: string) => Promise<void>

  const makeService = () =>
    new PublishService({
      publications,
      accounts,
      versions,
      connectors: { youtube, tiktok: new ManualConnector('tiktok'), instagram: new ManualConnector('instagram') },
      logger: memoryLogger(),
      emit: (e) => events.push(e)
    })

  beforeEach(async () => {
    google = new FakeGoogle()
    await google.start()
    db = createNodeSqliteDriver()
    runMigrations(db)
    secrets = new MemorySecretStore()
    accounts = new AccountsRepository(db)
    publications = new PublicationsRepository(db)
    versions = new VersionsRepository(db)
    projects = new ProjectsRepository(db)
    events = []
    const config = new YouTubeClientConfig(db, secrets)
    config.set(CLIENT)
    openBrowser = google.approve
    youtube = new YouTubeConnector({
      accounts,
      secrets,
      config,
      fetch: (url, init) => fetch(url, init),
      openBrowser: (url) => openBrowser(url),
      logger: memoryLogger(),
      endpoints: google.endpoints,
      sleep: async () => {},
      chunkSize: 256 * 1024
    })
    service = makeService()

    // A ready 9:16 version backed by a real file (content of the bytes doesn't matter to the API).
    videoFile = join(root.path, `${randomUUID()}.mp4`)
    writeFileSync(videoFile, randomBytes(1024 * 1024 + 12345))
    const contents = new ContentsRepository(db)
    const content = contents.insertPending({ path: '/src/ko.mp4', pathKey: '/src/ko.mp4', size: 1, mtimeMs: 1 })!
    contentId = content.id
    const v = versions.createRendering({ contentId, name: 'Clean 9:16', settings: defaultEditSettings(), filePath: videoFile })
    versions.markReady(v.id, { fileSize: 1, durationSeconds: 20, width: 1080, height: 1920, aspectRatio: '9:16', encoder: 'libopenh264', thumbnailPath: null })
    versionId = v.id
  })

  afterEach(async () => {
    service.shutdown()
    await google.stop()
    db.close()
  })

  const ytDestination = (accountId: string, patch: Partial<DestinationInput> = {}): DestinationInput => ({
    accountId,
    title: 'Nocaute no primeiro round',
    caption: 'Que soco!',
    hashtags: ['#mma', 'ufc'],
    fields: { privacy: 'unlisted', madeForKids: false, categoryId: '17' },
    ...patch
  })

  const connect = async (projectIds: string[] = []) => youtube.connect(projectIds)

  it('connects a channel with OAuth + PKCE through the loopback redirect, storing tokens only in the secret store', async () => {
    const mma = projects.create(CreateProjectInputSchema.parse({ name: 'MMA' }))
    const account = await connect([mma.id])
    expect(account).toMatchObject({ platformId: 'youtube', externalAccountId: 'UC123', displayName: 'MMA Cortes', connectionStatus: 'connected', manual: false, projectIds: [mma.id] })

    const record = accounts.record(account.id)
    const tokens = secrets.load<StoredTokens>(record.tokenRef!)
    expect(tokens).toMatchObject({ refreshToken: 'refresh-1' })
    // Nothing secret in the database.
    const dump = JSON.stringify(db.prepare('SELECT * FROM accounts').all()) + JSON.stringify(db.prepare('SELECT * FROM app_settings').all())
    expect(dump).not.toContain('refresh-1')
    expect(dump).not.toContain(tokens!.accessToken)
    expect(dump).not.toContain(CLIENT.clientSecret)

    // Reconnecting the same channel keeps the account (and its history), with a fresh token.
    const again = await connect()
    expect(again.id).toBe(account.id)
    expect(accounts.list()).toHaveLength(1)
  })

  it('reports a denied authorization', async () => {
    openBrowser = google.deny
    await expect(connect()).rejects.toThrow(/não autorizou/)
    expect(accounts.list()).toEqual([])
  })

  it('uploads with the resumable protocol and records the published video', async () => {
    const account = await connect()
    const { created } = service.create({ versionId, destinations: [ytDestination(account.id)], allowRepeat: false, requestId: randomUUID() })
    expect(created[0]).toMatchObject({ status: 'queued', hashtags: ['#mma', '#ufc'] })
    await service.waitForIdle()

    const published = publications.get(created[0]!.id)
    expect(published).toMatchObject({ status: 'published', externalPostId: 'vid-s1', externalUrl: 'https://www.youtube.com/shorts/vid-s1' })
    expect(published.fields.upload).toBeUndefined()
    expect(published.publishedAt).not.toBeNull()

    expect(google.uploadedVideos).toHaveLength(1)
    const video = google.uploadedVideos[0]!
    expect(video.bytes.equals(readFileSync(videoFile))).toBe(true)
    expect(video.metadata).toEqual({
      snippet: { title: 'Nocaute no primeiro round', description: 'Que soco!\n\n#mma #ufc', tags: ['mma', 'ufc'], categoryId: '17' },
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false, embeddable: true }
    })
    // Progress was reported while uploading.
    expect(events.some((e) => e.type === 'publication' && (e.publication.fields.progress ?? 0) > 0.2 && e.publication.status === 'publishing')).toBe(true)
  })

  it('survives server errors and a dropped connection, asking the server where to continue', async () => {
    const account = await connect()
    google.failChunksWith503 = 2
    google.dropNextChunkConnection = true
    const { created } = service.create({ versionId, destinations: [ytDestination(account.id)], allowRepeat: false, requestId: randomUUID() })
    await service.waitForIdle()
    expect(publications.get(created[0]!.id).status).toBe('published')
    expect(google.sessions.size).toBe(1)
    expect(google.uploadedVideos[0]!.bytes.equals(readFileSync(videoFile))).toBe(true)
  })

  it('continues an interrupted upload after a restart instead of starting over', async () => {
    const account = await connect()
    const { created } = service.create({ versionId, destinations: [ytDestination(account.id)], allowRepeat: false, requestId: randomUUID() })
    const id = created[0]!.id
    // Quit while uploading.
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if ((publications.get(id).fields.progress ?? 0) >= 0.4) {
          clearInterval(timer)
          service.shutdown()
          resolve()
        }
      }, 1)
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(publications.get(id).status).toBe('publishing')
    expect(publications.get(id).fields.upload?.sessionUri).toContain('/session/s1')
    const bytesBefore = google.sessions.get('s1')!.bytes
    expect(bytesBefore).toBeGreaterThan(0)

    service = makeService()
    service.start()
    await service.waitForIdle()
    expect(publications.get(id).status).toBe('published')
    expect(google.sessions.size).toBe(1) // same session, continued
    expect(google.uploadedVideos).toHaveLength(1)
    expect(google.uploadedVideos[0]!.bytes.equals(readFileSync(videoFile))).toBe(true)
  })

  it('starts a new session when the saved one expired', async () => {
    const account = await connect()
    const { created } = service.create({ versionId, destinations: [ytDestination(account.id)], allowRepeat: false, requestId: randomUUID() })
    const id = created[0]!.id
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if ((publications.get(id).fields.progress ?? 0) >= 0.3) {
          clearInterval(timer)
          service.shutdown()
          resolve()
        }
      }, 1)
    })
    await new Promise((r) => setTimeout(r, 50))
    google.expireNextSessionQuery = true
    service = makeService()
    service.start()
    await service.waitForIdle()
    expect(publications.get(id).status).toBe('published')
    expect(google.uploadedVideos).toHaveLength(1)
    expect(google.uploadedVideos[0]!.bytes.equals(readFileSync(videoFile))).toBe(true)
  })

  it('refreshes an expired access token automatically', async () => {
    const account = await connect()
    google.invalidateAccessTokens()
    const { created } = service.create({ versionId, destinations: [ytDestination(account.id)], allowRepeat: false, requestId: randomUUID() })
    await service.waitForIdle()
    expect(publications.get(created[0]!.id).status).toBe('published')
  })

  it('asks to reconnect when the grant was revoked, and keeps the publication for a retry', async () => {
    const account = await connect()
    google.invalidateAccessTokens()
    google.refreshFails = true
    const { created } = service.create({ versionId, destinations: [ytDestination(account.id)], allowRepeat: false, requestId: randomUUID() })
    await service.waitForIdle()
    const failed = publications.get(created[0]!.id)
    expect(failed.status).toBe('failed')
    expect(failed.errorMessage).toContain('Conecte a conta de novo')
    expect(accounts.get(account.id).connectionStatus).toBe('expired')
    expect(events).toContainEqual({ type: 'accounts' })
    expect(() => service.retry(failed.id)).toThrow(/não está conectada/)

    // After reconnecting, the retry goes through.
    google.refreshFails = false
    await connect()
    service.retry(failed.id)
    await service.waitForIdle()
    expect(publications.get(failed.id).status).toBe('published')
  })

  it('explains an exhausted API quota', async () => {
    const account = await connect()
    google.quotaExceeded = true
    const { created } = service.create({ versionId, destinations: [ytDestination(account.id)], allowRepeat: false, requestId: randomUUID() })
    await service.waitForIdle()
    expect(publications.get(created[0]!.id)).toMatchObject({ status: 'failed' })
    expect(publications.get(created[0]!.id).errorMessage).toContain('cota diária')
  })

  it('never creates a publication twice for the same request, and asks before repeating a destination', async () => {
    const account = await connect()
    const requestId = randomUUID()
    const first = service.create({ versionId, destinations: [ytDestination(account.id)], allowRepeat: false, requestId })
    const again = service.create({ versionId, destinations: [ytDestination(account.id)], allowRepeat: false, requestId })
    expect(again.created[0]!.id).toBe(first.created[0]!.id)
    await service.waitForIdle()
    expect(google.uploadedVideos).toHaveLength(1)

    expect(() => service.create({ versionId, destinations: [ytDestination(account.id)], allowRepeat: false, requestId: randomUUID() })).toThrow(
      /já foi publicada/
    )
    service.create({ versionId, destinations: [ytDestination(account.id)], allowRepeat: true, requestId: randomUUID() })
    await service.waitForIdle()
    expect(google.uploadedVideos).toHaveLength(2)
  })

  it('treats destinations independently: a failing API upload does not affect a manual destination', async () => {
    const yt = await connect()
    const tiktok = accounts.addManual({ platformId: 'tiktok', displayName: '@mma.cortes', projectIds: [] })
    google.quotaExceeded = true
    const { created } = service.create({
      versionId,
      destinations: [ytDestination(yt.id), { accountId: tiktok.id, title: null, caption: 'Que soco!', hashtags: ['#mma'], fields: {} }],
      allowRepeat: false,
      requestId: randomUUID()
    })
    await service.waitForIdle()
    const [ytPub, ttPub] = created.map((p) => publications.get(p.id))
    expect(ytPub!.status).toBe('failed')
    expect(ttPub!.status).toBe('manual_pending')

    const confirmed = service.markManualPublished(ttPub!.id, 'https://www.tiktok.com/@mma.cortes/video/1')
    expect(confirmed).toMatchObject({ status: 'published', externalUrl: 'https://www.tiktok.com/@mma.cortes/video/1' })
    expect(() => service.markManualPublished(ttPub!.id, null)).toThrow()
    expect(publications.list({ contentId }).map((p) => [p.accountName, p.status])).toEqual(
      expect.arrayContaining([['MMA Cortes', 'failed'], ['@mma.cortes', 'published']])
    )
  })

  it('validates every destination before creating any', async () => {
    const yt = await connect()
    const tiktok = accounts.addManual({ platformId: 'tiktok', displayName: '@x', projectIds: [] })
    expect(() =>
      service.create({
        versionId,
        destinations: [
          { accountId: tiktok.id, title: null, caption: 'ok', hashtags: [], fields: {} },
          ytDestination(yt.id, { title: '  ' })
        ],
        allowRepeat: false,
        requestId: randomUUID()
      })
    ).toThrow(/exige um título/)
    expect(() =>
      service.create({ versionId, destinations: [ytDestination(yt.id, { fields: { privacy: 'public' } })], allowRepeat: false, requestId: randomUUID() })
    ).toThrow(/feito para crianças/)
    expect(publications.list()).toEqual([])
  })

  it('cancels a queued publication', async () => {
    const account = await connect()
    const tiktok = accounts.addManual({ platformId: 'tiktok', displayName: '@x', projectIds: [] })
    const { created } = service.create({
      versionId,
      destinations: [{ accountId: tiktok.id, title: null, caption: null, hashtags: [], fields: {} }],
      allowRepeat: false,
      requestId: randomUUID()
    })
    expect(service.cancel(created[0]!.id).status).toBe('cancelled')
    expect(account.id).toBeTruthy()
  })

  it('disconnects (revoking at Google) and keeps history; accounts with publications cannot be removed', async () => {
    const account = await connect()
    service.create({ versionId, destinations: [ytDestination(account.id)], allowRepeat: false, requestId: randomUUID() })
    await service.waitForIdle()
    const record = accounts.record(account.id)
    await youtube.disconnect(record)
    const { tokenRef } = accounts.disconnect(account.id)
    secrets.delete(tokenRef!)
    expect(google.revoked).toEqual(['refresh-1'])
    expect(accounts.get(account.id).connectionStatus).toBe('disconnected')
    expect(secrets.values.size).toBe(1) // only the client secret is left
    expect(() => accounts.remove(account.id)).toThrow(/histórico/)
    expect(publications.list()).toHaveLength(1)
  })

  it('sanitizes metadata to YouTube’s rules', () => {
    const meta = sanitizeMetadata({
      title: `<b>${'x'.repeat(120)}</b>`,
      description: 'a <b> c',
      tags: ['#mma', 'ufc', ...Array.from({ length: 80 }, (_, i) => `tag-numero-${i}`)],
      categoryId: '17',
      privacyStatus: 'public',
      madeForKids: false
    })
    expect(meta.title).toHaveLength(100)
    expect(meta.title).not.toMatch(/[<>]/)
    expect(meta.description).toBe('a b c')
    expect(meta.tags[0]).toBe('mma')
    expect(meta.tags.join(',').length).toBeLessThanOrEqual(500)
    expect(composeCaption('Texto', ['mma', '#mma', '#ufc'])).toBe('Texto\n\n#mma #ufc')
  })

  it('stores secrets encrypted on disk', () => {
    const dir = join(root.path, `secrets-${randomUUID()}`)
    const cipher = {
      isAvailable: () => true,
      encrypt: (s: string) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
      decrypt: (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8')
    }
    const store = new FileSecretStore(dir, cipher)
    const ref = store.save({ refreshToken: 'super-secret-refresh' })
    const file = readdirSync(dir)[0]!
    expect(readFileSync(join(dir, file), 'utf8')).not.toContain('super-secret-refresh')
    expect(store.load<{ refreshToken: string }>(ref)).toEqual({ refreshToken: 'super-secret-refresh' })
    store.delete(ref)
    expect(store.load(ref)).toBeNull()
    expect(() => new FileSecretStore(dir, { ...cipher, isAvailable: () => false }).save({})).toThrow(/criptografia/)
  })

  it('rejects bad credentials clearly', async () => {
    expect(new OAuthError('x', true).reauthorize).toBe(true)
    const config = new YouTubeClientConfig(db, secrets)
    config.clear()
    expect(youtube.info().configured).toBe(false)
    await expect(connect()).rejects.toThrow(/Configure o Client ID/)
  })
})

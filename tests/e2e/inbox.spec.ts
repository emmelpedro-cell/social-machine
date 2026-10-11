import { expect, test, type ElectronApplication } from '@playwright/test'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createFixtures, testTools } from '../helpers/media'
import { FakeGoogle } from '../helpers/fake-google'
import { card, launchApp, makeDataDir, navigate, openLibrary, stubOpenDialog } from './helpers'

/**
 * Phase 6 acceptance through the real UI: comments of a channel arrive in the
 * Inbox (linked to the content published from the app), are filtered, read,
 * resolved and answered — the reply written by the user and sent once — and
 * platforms without a comments API say so.
 */
test.describe.configure({ mode: 'serial' })

const dataDir = makeDataDir('inbox')
const google = new FakeGoogle()
let env: Record<string, string>

test.beforeAll(async () => {
  const tools = testTools()
  if (!tools) throw new Error('FFmpeg is required for the E2E tests. Run "npm run fetch:ffmpeg".')
  const fx = createFixtures(tools, join(dataDir, 'fixtures'))
  mkdirSync(join(dataDir, 'footage'), { recursive: true })
  copyFileSync(fx.vertical, join(dataDir, 'footage', 'Kickflip.mp4'))
  await google.start()
  env = { SM_GOOGLE_ENDPOINTS: JSON.stringify(google.endpoints) }
})

test.afterAll(async () => {
  await google.stop()
  if (!process.env.SM_E2E_DATA) rmSync(dataDir, { recursive: true, force: true })
})

async function stubBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }, approveUrl) => {
    ;(globalThis as { opened?: string[] }).opened = []
    shell.openExternal = (async (url: string) => {
      if (url.includes('/auth?')) await fetch(`${approveUrl}?url=${encodeURIComponent(url)}`)
      else (globalThis as { opened?: string[] }).opened!.push(url)
    }) as typeof shell.openExternal
  }, google.endpoints.auth.replace('/auth', '/__approve'))
}

test('reads, filters, resolves and answers comments in one place', async () => {
  const { app, page } = await launchApp(dataDir, { env })
  await stubBrowser(app)

  await navigate(page, 'Contas')
  await page.getByTestId('youtube-client-id').fill('123-abc.apps.googleusercontent.com')
  await page.getByTestId('youtube-client-secret').fill('GOCSPX-e2e')
  await page.getByTestId('youtube-save-credentials').click()
  await page.getByTestId('connect-youtube').click()
  await expect(page.locator('[data-testid="account-item"][data-name="MMA Cortes"]')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 })
  await page.getByTestId('manual-name-tiktok').fill('@skate.cortes')
  await page.getByTestId('add-manual-tiktok').click()
  await expect(page.locator('[data-testid="account-item"][data-name="@skate.cortes"]')).toBeVisible()

  // A video published from the app.
  await openLibrary(page)
  await expect(page.getByTestId('import-files')).toBeEnabled({ timeout: 30_000 })
  await stubOpenDialog(app, [join(dataDir, 'footage', 'Kickflip.mp4')])
  await page.getByTestId('import-files').click()
  await expect(card(page, 'Kickflip.mp4')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
  const contents = await page.evaluate(() => window.sm.media.list())
  if (!contents.ok) throw new Error(contents.error.message)
  const contentId = contents.data[0]!.id
  const settings = { version: 1, output: { preset: '9:16' }, trim: { start: 0, end: null }, frame: { fit: 'cover', zoom: 1, x: 0, y: 0, background: 'blur' }, texts: [], audio: { mute: false } } as const
  const v = await page.evaluate(({ contentId, settings }) => window.sm.versions.create({ contentId, name: 'Clean 9:16', settings: settings as never, overlays: [] }), { contentId, settings })
  if (!v.ok) throw new Error(v.error.message)
  await expect
    .poll(async () => {
      const list = await page.evaluate((id) => window.sm.versions.list(id), contentId)
      return list.ok ? list.data[0]?.status : 'error'
    }, { timeout: 120_000 })
    .toBe('ready')
  const versions = await page.evaluate((id) => window.sm.versions.list(id), contentId)
  const accounts = await page.evaluate(() => window.sm.accounts.list())
  if (!versions.ok || !accounts.ok) throw new Error('lists')
  const yt = accounts.data.find((a) => a.platformId === 'youtube')!
  const created = await page.evaluate(
    ({ versionId, accountId }) =>
      window.sm.publications.create({
        versionId,
        destinations: [{ accountId, title: 'Kickflip na escada', caption: null, hashtags: [], fields: { privacy: 'public', madeForKids: false, categoryId: '17' } }],
        allowRepeat: false,
        requestId: crypto.randomUUID()
      }),
    { versionId: versions.data[0]!.id, accountId: yt.id }
  )
  if (!created.ok) throw new Error(created.error.message)
  await expect.poll(() => google.uploadedVideos.length, { timeout: 60_000 }).toBe(1)
  const videoId = google.uploadedVideos[0]!.id
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
  google.threads.push(
    { id: 'c1', videoId, canReply: true, top: { id: 'c1', text: 'Qual é o modelo do skate?', author: 'Ana', authorChannelId: 'UCana', publishedAt: ago(30) }, replies: [] },
    { id: 'c2', videoId, canReply: true, top: { id: 'c2', text: 'Esse lance foi absurdo!', author: 'Bruno', authorChannelId: 'UCbruno', publishedAt: ago(20) }, replies: [] },
    { id: 'c3', videoId: 'outroVideo', canReply: false, top: { id: 'c3', text: 'Comentário em outro vídeo', author: 'Caio', authorChannelId: 'UCcaio', publishedAt: ago(10) }, replies: [] }
  )

  await navigate(page, 'Inbox')
  await expect(page.locator('[data-testid="inbox-account"][data-account="@skate.cortes"]')).toContainText('app aprovado')
  await expect(page.locator('[data-testid="inbox-account"][data-account="MMA Cortes"] [data-testid="cap-reply"]')).toContainText('✓')
  await page.getByTestId('inbox-sync').click()
  const items = page.getByTestId('inbox-item')
  await expect(items).toHaveCount(3)
  await expect(page.getByRole('navigation').getByTestId('nav-badge-inbox')).toHaveText('3')

  // Filter by content (only the comments on the video published from the app) and by text.
  await page.getByTestId('inbox-filter-content').selectOption({ label: 'Kickflip.mp4' })
  await expect(items).toHaveCount(2)
  await page.getByTestId('inbox-search').fill('skate')
  await expect(items).toHaveCount(1)
  await page.getByTestId('inbox-search').fill('')

  // Open → read; answer it.
  await items.filter({ hasText: 'modelo do skate' }).click()
  await expect(items.filter({ hasText: 'modelo do skate' })).toHaveAttribute('data-read', 'read')
  await page.getByTestId('reply-text').fill('É um Element 8.0!')
  await page.getByTestId('reply-send').click()
  await expect(page.getByTestId('thread').getByTestId('thread-item')).toHaveCount(2)
  await expect(page.getByTestId('thread')).toContainText('(você)')
  expect(google.insertedReplies).toEqual([{ parentId: 'c1', text: 'É um Element 8.0!' }])

  // Replied ones leave "Abertos"; resolve another.
  await expect(items).toHaveCount(1)
  await items.first().click()
  await page.getByTestId('resolve').click()
  await expect(page.getByTestId('inbox-empty')).toBeVisible()
  await page.getByTestId('inbox-filter-resolved').click()
  await expect(items).toHaveCount(2)
  await expect(items.filter({ hasText: 'modelo do skate' })).toHaveAttribute('data-response', 'replied')

  // A comment on a video not published from the app: no reply allowed there, link to YouTube works.
  await page.getByTestId('inbox-filter-content').selectOption('all')
  await page.getByTestId('inbox-filter-all').click()
  await items.filter({ hasText: 'outro vídeo' }).click()
  await expect(page.getByTestId('reply-unavailable')).toBeVisible()
  await page.getByTestId('open-original').click()
  await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened)).toEqual(['https://www.youtube.com/watch?v=outroVideo&lc=c3'])

  // Open the related content.
  await page.getByTestId('inbox-filter-all').click()
  await items.filter({ hasText: 'absurdo' }).click()
  await page.getByTestId('open-content').click()
  await expect(page.getByTestId('content-performance')).toBeVisible()
  await app.close()
})

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createFixtures, testTools } from '../helpers/media'
import { FakeGoogle } from '../helpers/fake-google'
import { card, launchApp, makeDataDir, navigate, openCard, openLibrary, stubOpenDialog } from './helpers'

/**
 * Phase 5 acceptance through the real UI: a version published to YouTube
 * (metrics from the Data API + YouTube Analytics stand-in) and to a manual
 * TikTok account (numbers typed in), compared by platform and per content;
 * missing data shown as unavailable; a disabled Analytics API explained.
 */
test.describe.configure({ mode: 'serial' })

const dataDir = makeDataDir('analytics')
const google = new FakeGoogle()
let env: Record<string, string>

test.beforeAll(async () => {
  const tools = testTools()
  if (!tools) throw new Error('FFmpeg is required for the E2E tests. Run "npm run fetch:ffmpeg".')
  const fx = createFixtures(tools, join(dataDir, 'fixtures'))
  mkdirSync(join(dataDir, 'footage'), { recursive: true })
  copyFileSync(fx.vertical, join(dataDir, 'footage', 'Nocaute.mp4'))
  await google.start()
  env = { SM_GOOGLE_ENDPOINTS: JSON.stringify(google.endpoints) }
})

test.afterAll(async () => {
  await google.stop()
  if (!process.env.SM_E2E_DATA) rmSync(dataDir, { recursive: true, force: true })
})

async function stubBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }, approveUrl) => {
    shell.openExternal = (async (url: string) => {
      if (url.includes('/auth?')) await fetch(`${approveUrl}?url=${encodeURIComponent(url)}`)
    }) as typeof shell.openExternal
  }, google.endpoints.auth.replace('/auth', '/__approve'))
}

async function publications(page: Page) {
  const list = await page.evaluate(() => window.sm.publications.list({}))
  if (!list.ok) throw new Error(list.error.message)
  return list.data
}

test('compares real metrics by platform and per content, never inventing missing numbers', async () => {
  const { app, page } = await launchApp(dataDir, { env })
  await stubBrowser(app)
  const created = await page.evaluate(() => window.sm.projects.create({ name: 'MMA', color: '#e5484d' }))
  if (!created.ok) throw new Error(created.error.message)
  await page.reload()
  await stubBrowser(app)

  // Accounts.
  await navigate(page, 'Contas')
  await page.getByTestId('youtube-client-id').fill('123-abc.apps.googleusercontent.com')
  await page.getByTestId('youtube-client-secret').fill('GOCSPX-e2e')
  await page.getByTestId('youtube-save-credentials').click()
  await page.getByTestId('connect-youtube').click()
  await expect(page.locator('[data-testid="account-item"][data-name="MMA Cortes"]')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 })
  await page.getByTestId('manual-name-tiktok').fill('@mma.cortes')
  await page.getByTestId('add-manual-tiktok').click()
  await expect(page.locator('[data-testid="account-item"][data-name="@mma.cortes"]')).toBeVisible()

  // A ready version in MMA.
  await openLibrary(page)
  await page.getByTestId('filter-project').selectOption({ label: 'MMA' })
  await expect(page.getByTestId('import-files')).toBeEnabled({ timeout: 30_000 })
  await stubOpenDialog(app, [join(dataDir, 'footage', 'Nocaute.mp4')])
  await page.getByTestId('import-files').click()
  await expect(card(page, 'Nocaute.mp4')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
  const contents = await page.evaluate(() => window.sm.media.list())
  if (!contents.ok) throw new Error(contents.error.message)
  const contentId = contents.data[0]!.id
  const settings = { version: 1, output: { preset: '9:16' }, trim: { start: 0, end: null }, frame: { fit: 'cover', zoom: 1, x: 0, y: 0, background: 'blur' }, texts: [], audio: { mute: false } } as const
  const v = await page.evaluate(
    ({ contentId, settings }) => window.sm.versions.create({ contentId, name: 'Clean 9:16', settings: settings as never, overlays: [] }),
    { contentId, settings }
  )
  if (!v.ok) throw new Error(v.error.message)
  await expect
    .poll(async () => {
      const list = await page.evaluate((id) => window.sm.versions.list(id), contentId)
      return list.ok ? list.data[0]?.status : 'error'
    }, { timeout: 120_000 })
    .toBe('ready')

  // Publish to both destinations.
  const accounts = await page.evaluate(() => window.sm.accounts.list())
  if (!accounts.ok) throw new Error(accounts.error.message)
  const yt = accounts.data.find((a) => a.platformId === 'youtube')!
  const tt = accounts.data.find((a) => a.platformId === 'tiktok')!
  const versions = await page.evaluate((id) => window.sm.versions.list(id), contentId)
  if (!versions.ok) throw new Error(versions.error.message)
  const result = await page.evaluate(
    ({ versionId, yt, tt }) =>
      window.sm.publications.create({
        versionId,
        destinations: [
          { accountId: yt, title: 'Nocaute', caption: null, hashtags: [], fields: { privacy: 'public', madeForKids: false, categoryId: '17' } },
          { accountId: tt, title: 'Nocaute', caption: null, hashtags: [], fields: {} }
        ],
        allowRepeat: false,
        requestId: crypto.randomUUID()
      }),
    { versionId: versions.data[0]!.id, yt: yt.id, tt: tt.id }
  )
  if (!result.ok) throw new Error(result.error.message)
  await expect.poll(async () => (await publications(page)).find((p) => p.accountId === yt.id)?.status, { timeout: 60_000 }).toBe('published')
  const ttPub = (await publications(page)).find((p) => p.accountId === tt.id)!
  await page.evaluate((id) => window.sm.publications.markPublished(id, ''), ttPub.id)

  // What "YouTube" reports.
  const videoId = google.uploadedVideos[0]!.id
  google.videoStats.set(videoId, { viewCount: '1500', likeCount: '120', commentCount: '14' })
  google.videoAnalytics.set(videoId, { minutes: 300, avgDuration: 12, avgPercentage: 55, shares: 9, subscribers: 4 })

  await navigate(page, 'Analytics')
  await expect(page.getByTestId('tile-publications')).toContainText('2')
  await page.getByTestId('analytics-refresh').click()
  await expect(page.getByTestId('tile-views')).toContainText('1.500')
  await expect(page.getByTestId('tile-views')).toContainText('1 de 2 com dado')
  await expect(page.getByTestId('tile-engagement')).toContainText('9,53%') // (120 + 14 + 9) / 1500
  await expect(page.getByTestId('tile-watch')).toContainText('5 h')
  await expect(page.getByTestId('tile-followers')).toContainText('4')
  await expect(page.locator('[data-testid="followers-item"][data-account="MMA Cortes"]')).toContainText('1.200')
  // TikTok has no numbers yet: its bar says so.
  await expect(page.locator('[data-testid="compare-bars"] [data-testid="bar-row"][data-key="TikTok"]')).toContainText('indisponível')

  // Content page: type in the TikTok numbers.
  await page.locator('[data-testid="content-row"][data-name="Nocaute.mp4"]').click()
  const perf = page.getByTestId('content-performance')
  await expect(perf.getByTestId('performance-table')).toContainText('1.500')
  const form = perf.locator('[data-testid="manual-metrics"][data-account="@mma.cortes"]')
  await form.getByTestId('manual-views').fill('12,5 mil')
  await form.getByTestId('manual-likes').fill('900')
  await form.getByTestId('manual-comments').fill('40')
  await form.getByTestId('manual-shares').fill('60')
  await form.getByTestId('manual-metrics-save').click()
  await expect(perf.getByTestId('performance-table')).toContainText('12.500')
  await expect(perf.getByTestId('performance-table')).toContainText('informado por você')

  // Back to the overview: TikTok now leads by views per publication.
  await perf.getByTestId('performance-back').click()
  await expect(page.getByTestId('tile-views')).toContainText('14.000')
  const bars = page.locator('[data-testid="compare-bars"] [data-testid="bar-row"]')
  await expect(bars.first()).toHaveAttribute('data-key', 'TikTok')
  await expect(page.getByTestId('compare-table')).toContainText('YouTube')
  await page.getByTestId('dimension-project').click()
  await expect(bars.first()).toHaveAttribute('data-key', 'MMA')

  // From the library too.
  await openLibrary(page)
  await openCard(page, 'Nocaute.mp4')
  await page.getByTestId('open-performance').click()
  await expect(page.getByTestId('content-performance')).toBeVisible()

  // The Analytics API turned off in the Google project: counters still update, and the reason is shown.
  google.analyticsDisabled = true
  google.videoStats.set(videoId, { viewCount: '1700', likeCount: '130', commentCount: '15' })
  await page.getByTestId('performance-back').click()
  await page.getByTestId('analytics-refresh').click()
  await expect(page.getByTestId('metrics-problem')).toContainText('YouTube Analytics API não está ativada')
  await expect(page.getByTestId('tile-views')).toContainText('14.200')
  await app.close()
})

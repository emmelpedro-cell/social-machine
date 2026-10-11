import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createFixtures, testTools, type Fixtures } from '../helpers/media'
import { FakeGoogle } from '../helpers/fake-google'
import { card, launchApp, makeDataDir, navigate, openCard, openLibrary, stubOpenDialog } from './helpers'

/**
 * Phase 3 acceptance through the real UI, against a local stand-in for
 * Google (SM_GOOGLE_ENDPOINTS works only in unpackaged builds): configure the
 * YouTube client, connect a channel through the OAuth consent redirect,
 * publish a version to YouTube (resumable upload) and to a manual TikTok
 * account, confirm the manual one, and find everything after a restart.
 */
test.describe.configure({ mode: 'serial' })

const dataDir = makeDataDir('publishing')
const google = new FakeGoogle()
let fx: Fixtures
let env: Record<string, string>

test.beforeAll(async () => {
  const tools = testTools()
  if (!tools) throw new Error('FFmpeg is required for the E2E tests. Run "npm run fetch:ffmpeg".')
  fx = createFixtures(tools, join(dataDir, 'fixtures'))
  mkdirSync(join(dataDir, 'footage'), { recursive: true })
  copyFileSync(fx.vertical, join(dataDir, 'footage', 'Nocaute vertical.mp4'))
  await google.start()
  env = { SM_GOOGLE_ENDPOINTS: JSON.stringify(google.endpoints) }
})

test.afterAll(async () => {
  await google.stop()
  if (!process.env.SM_E2E_DATA) rmSync(dataDir, { recursive: true, force: true })
})

/** The browser: instead of opening a window, hand the consent URL to the fake Google, which approves it. */
async function stubBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }, approveUrl) => {
    shell.openExternal = (async (url: string) => {
      if (url.includes('/auth?')) await fetch(`${approveUrl}?url=${encodeURIComponent(url)}`)
    }) as typeof shell.openExternal
  }, google.endpoints.auth.replace('/auth', '/__approve'))
}

async function readyVersion(page: Page, app: ElectronApplication): Promise<{ contentId: string; versionId: string; filePath: string }> {
  await openLibrary(page)
  await page.getByTestId('filter-project').selectOption({ label: 'MMA' })
  await expect(page.getByTestId('import-files')).toBeEnabled({ timeout: 30_000 })
  await stubOpenDialog(app, [join(dataDir, 'footage', 'Nocaute vertical.mp4')])
  await page.getByTestId('import-files').click()
  await expect(card(page, 'Nocaute vertical.mp4')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
  const contents = await page.evaluate(() => window.sm.media.list())
  if (!contents.ok) throw new Error(contents.error.message)
  const contentId = contents.data[0]!.id
  const settings = { version: 1, output: { preset: '9:16' }, trim: { start: 0, end: null }, frame: { fit: 'cover', zoom: 1, x: 0, y: 0, background: 'blur' }, texts: [], audio: { mute: false } } as const
  const created = await page.evaluate(
    ({ contentId, settings }) => window.sm.versions.create({ contentId, name: 'Clean 9:16', settings: settings as never, overlays: [] }),
    { contentId, settings }
  )
  if (!created.ok) throw new Error(created.error.message)
  await expect
    .poll(async () => {
      const list = await page.evaluate((id) => window.sm.versions.list(id), contentId)
      return list.ok ? list.data[0]?.status : 'error'
    }, { timeout: 120_000 })
    .toBe('ready')
  const list = await page.evaluate((id) => window.sm.versions.list(id), contentId)
  if (!list.ok) throw new Error(list.error.message)
  return { contentId, versionId: list.data[0]!.id, filePath: list.data[0]!.filePath! }
}

test('connects YouTube, publishes to YouTube and to a manual TikTok account', async () => {
  const { app, page } = await launchApp(dataDir, { env })
  await stubBrowser(app)
  const project = await page.evaluate(() => window.sm.projects.create({ name: 'MMA', color: '#e5484d' }))
  expect(project.ok).toBe(true)
  await page.reload()
  await stubBrowser(app)

  // Configure the YouTube OAuth client (the secret never comes back to the UI).
  await navigate(page, 'Contas')
  await expect(page.getByTestId('youtube-setup')).toBeVisible()
  await page.getByTestId('youtube-client-id').fill('123-abc.apps.googleusercontent.com')
  await page.getByTestId('youtube-client-secret').fill('GOCSPX-e2e-secret')
  await page.getByTestId('youtube-save-credentials').click()
  await expect(page.getByTestId('youtube-setup')).toHaveCount(0)
  await expect(page.getByTestId('platform-youtube')).not.toContainText('GOCSPX')

  // Connect the channel: consent page → loopback redirect → token exchange with PKCE → channel.
  await page.getByTestId('connect-youtube').click()
  const channel = page.locator('[data-testid="account-item"][data-name="MMA Cortes"]')
  await expect(channel).toHaveAttribute('data-status', 'connected', { timeout: 30_000 })
  await channel.getByRole('button', { name: 'MMA' }).click()
  await expect(channel.getByRole('button', { name: 'MMA' })).toHaveAttribute('aria-pressed', 'true')

  // A manual TikTok destination.
  await page.getByTestId('manual-name-tiktok').fill('@mma.cortes')
  await page.getByTestId('add-manual-tiktok').click()
  await expect(page.locator('[data-testid="account-item"][data-name="@mma.cortes"]')).toBeVisible()

  const { filePath } = await readyVersion(page, app)

  // Publish from the library's details panel.
  await openCard(page, 'Nocaute vertical.mp4')
  await page.getByTestId('asset-detail').getByTestId('publish-version').click()
  const dialog = page.getByTestId('publish-dialog')
  await expect(dialog.locator('[data-testid="destination"][data-account="MMA Cortes"]')).toBeChecked() // preselected: project account
  await dialog.locator('[data-testid="destination"][data-account="@mma.cortes"]').check()
  await expect(dialog).toContainText('Vai aparecer como Short')
  await dialog.getByTestId('publish-title').fill('Nocaute no primeiro round')
  await dialog.getByTestId('publish-caption').fill('Que soco!')
  await dialog.getByTestId('publish-hashtags').fill('#mma ufc')
  await dialog.getByTestId('publish-privacy').selectOption('unlisted')
  await dialog.getByTestId('publish-submit').click()
  await expect(dialog.getByRole('alert')).toContainText('feito para crianças')
  await dialog.getByTestId('kids-no').check()
  await dialog.getByTestId('publish-submit').click()
  await expect(dialog).toHaveCount(0)

  const pubs = page.getByTestId('detail-publications')
  const yt = pubs.locator('[data-testid="publication-item"][data-account="MMA Cortes"]')
  const tt = pubs.locator('[data-testid="publication-item"][data-account="@mma.cortes"]')
  await expect(yt).toHaveAttribute('data-status', 'published', { timeout: 60_000 })
  await expect(tt).toHaveAttribute('data-status', 'manual_pending')

  // What reached "YouTube": the exact file and the metadata from the dialog.
  expect(google.uploadedVideos).toHaveLength(1)
  expect(google.uploadedVideos[0]!.bytes.equals(readFileSync(filePath))).toBe(true)
  expect(google.uploadedVideos[0]!.metadata).toMatchObject({
    snippet: { title: 'Nocaute no primeiro round', description: 'Que soco!\n\n#mma #ufc', tags: ['mma', 'ufc'], categoryId: '17' },
    status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false }
  })

  // Confirm the manual TikTok post.
  await tt.getByTestId('confirm-manual').click()
  await tt.getByTestId('manual-url').fill('https://www.tiktok.com/@mma.cortes/video/123')
  await tt.getByTestId('manual-save').click()
  await expect(tt).toHaveAttribute('data-status', 'published')

  // Publishing the same version again to the same account asks first.
  await page.getByTestId('asset-detail').getByTestId('publish-version').click()
  await dialog.getByTestId('kids-no').check()
  await dialog.getByTestId('publish-submit').click()
  await expect(dialog).toContainText('Confirme para publicar de novo')
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await app.close()
})

test('keeps accounts and publication history after a restart', async () => {
  const { app, page } = await launchApp(dataDir, { env })
  await navigate(page, 'Dashboard')
  const dash = page.getByTestId('dash-publications')
  await expect(dash.locator('[data-testid="publication-item"]')).toHaveCount(2)
  await expect(dash.locator('[data-testid="publication-item"][data-account="MMA Cortes"]')).toHaveAttribute('data-status', 'published')
  await navigate(page, 'Contas')
  await expect(page.locator('[data-testid="account-item"][data-name="MMA Cortes"]')).toHaveAttribute('data-status', 'connected')

  // Secrets are on disk only encrypted; the database has no token.
  for (const name of ['database.sqlite', 'database.sqlite-wal']) {
    const file = join(dataDir, 'app-data', name)
    if (!existsSync(file)) continue
    const bytes = readFileSync(file)
    expect(bytes.includes(Buffer.from('refresh-1')), name).toBe(false)
    expect(bytes.includes(Buffer.from('GOCSPX-e2e-secret')), name).toBe(false)
  }
  await app.close()
})

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createFixtures, testTools } from '../helpers/media'
import { FakeGoogle } from '../helpers/fake-google'
import { card, launchApp, makeDataDir, navigate, openCard, openLibrary, stubOpenDialog } from './helpers'

/**
 * Phase 4 acceptance through the real UI: schedule a version to YouTube
 * (native publishAt, uploaded right away as private) and to a manual TikTok
 * account (local schedule); reschedule, pause and resume from the queue; set
 * posting times; and move a post to another day by dragging it on the calendar.
 */
test.describe.configure({ mode: 'serial' })

const dataDir = makeDataDir('schedule')
const google = new FakeGoogle()
let env: Record<string, string>

const pad = (n: number) => String(n).padStart(2, '0')
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
const dayKey = (d: Date) => localInput(d).slice(0, 10)
const at = (daysFromToday: number, hour: number, minute = 0) => {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromToday, hour, minute)
}

test.beforeAll(async () => {
  const tools = testTools()
  if (!tools) throw new Error('FFmpeg is required for the E2E tests. Run "npm run fetch:ffmpeg".')
  const fx = createFixtures(tools, join(dataDir, 'fixtures'))
  mkdirSync(join(dataDir, 'footage'), { recursive: true })
  copyFileSync(fx.vertical, join(dataDir, 'footage', 'Finalização.mp4'))
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

test('schedules, reschedules, pauses and moves publications on the calendar', async () => {
  const { app, page } = await launchApp(dataDir, { env })
  await stubBrowser(app)

  // A YouTube channel and a manual TikTok account.
  await navigate(page, 'Contas')
  await page.getByTestId('youtube-client-id').fill('123-abc.apps.googleusercontent.com')
  await page.getByTestId('youtube-client-secret').fill('GOCSPX-e2e')
  await page.getByTestId('youtube-save-credentials').click()
  await page.getByTestId('connect-youtube').click()
  await expect(page.locator('[data-testid="account-item"][data-name="MMA Cortes"]')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 })
  await page.getByTestId('manual-name-tiktok').fill('@mma.cortes')
  await page.getByTestId('add-manual-tiktok').click()
  await expect(page.locator('[data-testid="account-item"][data-name="@mma.cortes"]')).toBeVisible()

  // A ready version.
  await openLibrary(page)
  await expect(page.getByTestId('import-files')).toBeEnabled({ timeout: 30_000 })
  await stubOpenDialog(app, [join(dataDir, 'footage', 'Finalização.mp4')])
  await page.getByTestId('import-files').click()
  await expect(card(page, 'Finalização.mp4')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
  const contents = await page.evaluate(() => window.sm.media.list())
  if (!contents.ok) throw new Error(contents.error.message)
  const settings = { version: 1, output: { preset: '9:16' }, trim: { start: 0, end: null }, frame: { fit: 'cover', zoom: 1, x: 0, y: 0, background: 'blur' }, texts: [], audio: { mute: false } } as const
  const created = await page.evaluate(
    ({ contentId, settings }) => window.sm.versions.create({ contentId, name: 'Clean 9:16', settings: settings as never, overlays: [] }),
    { contentId: contents.data[0]!.id, settings }
  )
  if (!created.ok) throw new Error(created.error.message)
  await expect
    .poll(async () => {
      const list = await page.evaluate((id) => window.sm.versions.list(id), contents.data[0]!.id)
      return list.ok ? list.data[0]?.status : 'error'
    }, { timeout: 120_000 })
    .toBe('ready')
  await openCard(page, 'Finalização.mp4')

  // Schedule both destinations for the day after tomorrow at 15:00.
  const when = at(2, 15)
  await page.getByTestId('asset-detail').getByTestId('publish-version').click()
  const dialog = page.getByTestId('publish-dialog')
  await dialog.locator('[data-testid="destination"][data-account="MMA Cortes"]').check()
  await dialog.locator('[data-testid="destination"][data-account="@mma.cortes"]').check()
  await dialog.getByTestId('publish-title').fill('Finalização no segundo round')
  await dialog.getByTestId('kids-no').check()
  await dialog.getByTestId('when-schedule').check()
  await dialog.getByTestId('schedule-at').fill(localInput(when))
  await expect(dialog.getByTestId('schedule-mode')).toHaveValue('platform')
  await dialog.getByTestId('publish-submit').click()
  await expect(dialog).toHaveCount(0)

  // YouTube: uploaded now as private with publishAt; TikTok: waits for its time.
  await expect.poll(async () => (await publications(page)).find((p) => p.accountName === 'MMA Cortes')?.externalPostId ?? null, { timeout: 60_000 }).not.toBeNull()
  const pubs = await publications(page)
  const yt = pubs.find((p) => p.accountName === 'MMA Cortes')!
  const tt = pubs.find((p) => p.accountName === '@mma.cortes')!
  expect(yt).toMatchObject({ status: 'scheduled', scheduledAt: when.toISOString(), fields: { scheduleMode: 'platform' } })
  expect(tt).toMatchObject({ status: 'scheduled', scheduledAt: when.toISOString(), fields: { scheduleMode: 'local' } })
  expect(google.uploadedVideos[0]!.metadata).toMatchObject({ status: { privacyStatus: 'private', publishAt: when.toISOString() } })

  // The queue groups them by day.
  await navigate(page, 'Fila')
  const day = page.locator(`[data-testid="queue-day"][data-day="${dayKey(when)}"]`)
  await expect(day.getByTestId('publication-item')).toHaveCount(2)
  const ytItem = day.locator('[data-testid="publication-item"][data-account="MMA Cortes"]')
  await expect(ytItem.getByTestId('reschedule')).toHaveCount(0) // already on YouTube: changed in YouTube Studio
  await expect(ytItem.getByTestId('publication-status')).toHaveText('Agendada no YouTube')

  // Reschedule TikTok to tomorrow at 20:30 from the queue.
  const later = at(1, 20, 30)
  const ttItem = day.locator('[data-testid="publication-item"][data-account="@mma.cortes"]')
  await ttItem.getByTestId('reschedule').click()
  await ttItem.getByTestId('reschedule-time').fill(localInput(later))
  await ttItem.getByTestId('reschedule-save').click()
  const tomorrow = page.locator(`[data-testid="queue-day"][data-day="${dayKey(later)}"]`)
  await expect(tomorrow.locator('[data-testid="publication-item"][data-account="@mma.cortes"]')).toBeVisible()

  // Pause: it moves to "Precisa de você"; resume brings it back.
  await tomorrow.locator('[data-testid="publication-item"][data-account="@mma.cortes"]').getByTestId('pause').click()
  const paused = page.getByTestId('queue-attention').locator('[data-testid="publication-item"][data-account="@mma.cortes"]')
  await expect(paused).toHaveAttribute('data-status', 'draft')
  await paused.getByTestId('resume').click()
  await expect(tomorrow.locator('[data-testid="publication-item"][data-account="@mma.cortes"]')).toHaveAttribute('data-status', 'scheduled')

  // Posting times for TikTok.
  const prefs = page.locator('[data-testid="posting-account"][data-account="@mma.cortes"]')
  await prefs.getByTestId('posting-times-input').fill('10:00, 21h')
  await prefs.getByTestId('posting-times-input').blur()
  await expect
    .poll(async () => {
      const list = await page.evaluate(() => window.sm.queue.settings())
      return list.ok ? list.data.find((s) => s.accountId === tt.accountId)?.times : null
    })
    .toEqual(['10:00', '21:00'])
  const slots = await page.evaluate((id) => window.sm.queue.nextSlots(id, 3), tt.accountId)
  expect(slots.ok && slots.data.every((s) => ['10:00', '21:00'].includes(`${pad(new Date(s).getHours())}:${pad(new Date(s).getMinutes())}`))).toBe(true)

  // Calendar: drag TikTok from tomorrow to the day after (keeps 20:30).
  await navigate(page, 'Calendário')
  const target = at(2, 20, 30)
  const now = new Date()
  const monthsAhead = (later.getFullYear() - now.getFullYear()) * 12 + later.getMonth() - now.getMonth()
  for (let i = 0; i < monthsAhead; i++) await page.getByTestId('cal-next').click()
  const chip = page.locator(`[data-testid="cal-day"][data-day="${dayKey(later)}"] [data-testid="cal-item"][data-account="@mma.cortes"]`)
  await expect(chip).toBeVisible()
  await chip.dragTo(page.locator(`[data-testid="cal-day"][data-day="${dayKey(target)}"]`))
  await expect
    .poll(async () => (await publications(page)).find((p) => p.id === tt.id)?.scheduledAt)
    .toBe(target.toISOString())
  await expect(page.locator(`[data-testid="cal-day"][data-day="${dayKey(target)}"] [data-testid="cal-item"]`)).toHaveCount(2)

  // Details and the dashboard's upcoming list.
  await page.locator(`[data-testid="cal-day"][data-day="${dayKey(target)}"] [data-testid="cal-item"][data-account="@mma.cortes"]`).click()
  await expect(page.getByTestId('cal-detail').getByTestId('publication-item')).toHaveAttribute('data-account', '@mma.cortes')
  await navigate(page, 'Dashboard')
  await expect(page.getByTestId('dash-upcoming').getByTestId('publication-item')).toHaveCount(2)
  await app.close()
})

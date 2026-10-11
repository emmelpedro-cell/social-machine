import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { testTools } from '../helpers/media'
import { FakeGoogle } from '../helpers/fake-google'
import { card, launchApp, makeDataDir, navigate, openCard, openLibrary, stubOpenDialog } from '../e2e/helpers'

/**
 * Not a test: one session through the whole product, from a clip arriving in
 * the Drop Machine folder to analytics and the inbox, saving a numbered
 * screenshot per step plus a report (timings, errors seen by the app).
 * YouTube is the local Google stand-in; its numbers and comments are test data.
 */
const out = resolve('screenshots')
const dataDir = makeDataDir('journey')
const dropOutput = join(dataDir, 'drop-machine', 'public', 'output')
const google = new FakeGoogle()
const steps: { step: string; seconds: number }[] = []
const rendererErrors: string[] = []
let stepStart = Date.now()
let n = 0

test.setTimeout(15 * 60_000)

function clip(name: string, source: string, size: string, seconds = 8) {
  const tools = testTools()!
  execFileSync(tools.ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `${source}${source.includes('=') ? ':' : '='}size=${size}:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=220:duration=${seconds}`,
    '-t', String(seconds), '-c:v', 'libopenh264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart',
    name
  ])
}

/** Saves "NN-name.png" and records how long the step took. */
async function shot(page: Page, name: string, options: { top?: boolean } = {}) {
  for (const close of await page.locator('.notice-close').all()) await close.click().catch(() => undefined)
  if (options.top !== false) {
    await page.evaluate(() => document.querySelectorAll('.main, .library-main, .asset-detail').forEach((el) => el.scrollTo(0, 0)))
  }
  await page.waitForTimeout(600)
  n++
  const file = `${String(n).padStart(2, '0')}-${name}`
  await page.screenshot({ path: join(out, `${file}.png`) })
  steps.push({ step: file, seconds: Math.round((Date.now() - stepStart) / 100) / 10 })
  stepStart = Date.now()
}

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

test.beforeAll(async () => {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  mkdirSync(dropOutput, { recursive: true })
  await google.start()
})

test.afterAll(async () => {
  await google.stop()
})

test('journey', async () => {
  const { app, page } = await launchApp(dataDir, { env: { SM_GOOGLE_ENDPOINTS: JSON.stringify(google.endpoints) } })
  page.on('pageerror', (e) => rendererErrors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && rendererErrors.push(`console: ${m.text()}`))
  await stubBrowser(app)
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    win.setContentSize(1440, 900)
    win.center()
  })
  stepStart = Date.now()

  // 1. First run.
  await navigate(page, 'Dashboard')
  await shot(page, 'primeiro-uso')

  // 2. Projects.
  await navigate(page, 'Projetos')
  await page.getByTestId('create-suggested').click()
  await expect(page.getByTestId('project-item')).toHaveCount(4)
  await shot(page, 'projetos-criados')

  // 3. Drop Machine folder linked to MMA.
  await navigate(page, 'Configurações')
  await stubOpenDialog(app, [dropOutput])
  await page.getByTestId('add-drop-machine').click()
  await page.getByTestId('watch-item').getByTestId('watch-project').selectOption({ label: 'MMA' })
  await shot(page, 'pasta-drop-machine')

  // 4. The Drop Machine renders clips: they arrive by themselves.
  clip(join(dropOutput, 'MMA Drop 001.mp4'), 'mandelbrot', '720x1280')
  clip(join(dropOutput, 'MMA Drop 002 - nocaute.mp4'), 'testsrc2', '1280x720', 10)
  clip(join(dropOutput, 'MMA Drop 003.mp4'), 'cellauto=rule=110:full=0', '1280x720')
  await openLibrary(page)
  await expect
    .poll(async () => {
      const list = await page.evaluate(() => window.sm.media.list())
      return list.ok ? list.data.filter((c) => c.status === 'ready').length : 0
    }, { timeout: 120_000 })
    .toBe(3)
  await expect(card(page, 'MMA Drop 002 - nocaute.mp4')).toHaveAttribute('data-state', 'ready')
  await shot(page, 'biblioteca-clipes-chegaram')

  // 5. Details of one clip.
  await openCard(page, 'MMA Drop 002 - nocaute.mp4')
  await expect(page.getByTestId('asset-detail')).toBeVisible()
  await shot(page, 'detalhes-do-clipe')

  // 6–7. Editor: horizontal clip reframed to 9:16 with a title.
  await page.getByTestId('open-editor').click()
  await page.getByTestId('frame-zoom').fill('1.1')
  await page.getByTestId('tab-texts').click()
  await page.getByTestId('add-text').click()
  await page.getByTestId('text-content').fill('NOCAUTE NO 1º ROUND')
  await page.getByTestId('text-font').selectOption({ label: 'Anton' })
  await page.getByTestId('text-size').fill('0.065')
  await shot(page, 'editor-enquadramento-e-texto')
  await page.getByTestId('tab-export').click()
  await page.getByTestId('version-name').fill('Shorts 9:16')
  await page.getByTestId('export-version').click()
  await expect(page.locator('.editor-panel [data-testid="version-item"][data-name="Shorts 9:16"]')).toHaveAttribute('data-status', 'ready', { timeout: 180_000 })
  await shot(page, 'editor-versao-exportada')

  // 8. Accounts: YouTube channel (stand-in) + manual TikTok.
  await navigate(page, 'Contas')
  await page.getByTestId('youtube-client-id').fill('123-abc.apps.googleusercontent.com')
  await page.getByTestId('youtube-client-secret').fill('GOCSPX-demo')
  await page.getByTestId('youtube-save-credentials').click()
  await page.getByTestId('connect-youtube').click()
  const channel = page.locator('[data-testid="account-item"][data-name="MMA Cortes"]')
  await expect(channel).toHaveAttribute('data-status', 'connected', { timeout: 30_000 })
  await channel.getByRole('button', { name: 'MMA' }).click()
  await page.getByTestId('manual-name-tiktok').fill('@mma.cortes')
  await page.getByTestId('add-manual-tiktok').click()
  const tiktok = page.locator('[data-testid="account-item"][data-name="@mma.cortes"]')
  await expect(tiktok).toBeVisible()
  await tiktok.getByRole('button', { name: 'MMA' }).click()
  await shot(page, 'contas-conectadas')

  // 9. Schedule the version for tomorrow 19:00 on both.
  await openLibrary(page)
  await openCard(page, 'MMA Drop 002 - nocaute.mp4')
  await page.getByTestId('asset-detail').getByTestId('publish-version').click()
  const dialog = page.getByTestId('publish-dialog')
  await expect(dialog.locator('[data-testid="destination"][data-account="MMA Cortes"]')).toBeChecked()
  await dialog.locator('[data-testid="destination"][data-account="@mma.cortes"]').check()
  await dialog.getByTestId('publish-title').fill('Nocaute no primeiro round 🥊')
  await dialog.getByTestId('publish-caption').fill('Que golpe!')
  await dialog.getByTestId('kids-no').check()
  await dialog.getByTestId('when-schedule').check()
  const now = new Date()
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 19, 0)
  const pad = (x: number) => String(x).padStart(2, '0')
  await dialog.getByTestId('schedule-at').fill(`${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T19:00`)
  await dialog.getByTestId('schedule-mode').selectOption('local')
  await dialog.evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await shot(page, 'publicar-agendando', { top: false })
  await dialog.getByTestId('publish-submit').click()
  await expect(dialog).toHaveCount(0)

  // 10–11. Queue and calendar.
  await navigate(page, 'Fila')
  await expect(page.getByTestId('queue-upcoming').getByTestId('publication-item')).toHaveCount(2)
  await shot(page, 'fila-agendadas')
  await navigate(page, 'Calendário')
  await page.getByTestId('cal-view-week').click()
  if ((await page.getByTestId('cal-item').count()) === 0) await page.getByTestId('cal-next').click()
  await page.getByTestId('cal-item').first().click()
  await shot(page, 'calendario-semana')

  // 12. Changed my mind: publish now from the queue.
  await navigate(page, 'Fila')
  await page.locator('[data-testid="queue-upcoming"] [data-testid="publication-item"][data-account="MMA Cortes"]').getByTestId('publish-now').click()
  await page.locator('[data-testid="queue-upcoming"] [data-testid="publication-item"][data-account="@mma.cortes"]').getByTestId('publish-now').click()
  await expect.poll(async () => (await publications(page)).find((p) => p.accountName === 'MMA Cortes')?.status, { timeout: 60_000 }).toBe('published')
  const pending = page.locator('[data-testid="queue-attention"] [data-testid="publication-item"][data-account="@mma.cortes"]')
  await expect(pending).toHaveAttribute('data-status', 'manual_pending')
  await shot(page, 'fila-youtube-publicado-tiktok-aguardando')

  // 13. Posted on TikTok by hand: confirm with the link.
  await pending.getByTestId('confirm-manual').click()
  await pending.getByTestId('manual-url').fill('https://www.tiktok.com/@mma.cortes/video/7420000000000000000')
  await pending.getByTestId('manual-save').click()
  await expect(page.getByTestId('queue-published').getByTestId('publication-item')).toHaveCount(2)
  await shot(page, 'fila-tudo-publicado')

  // 14. Some hours later: numbers on YouTube (stand-in) and in the TikTok app.
  const videoId = google.uploadedVideos[0]!.id
  google.videoStats.set(videoId, { viewCount: '12840', likeCount: '962', commentCount: '71' })
  google.videoAnalytics.set(videoId, { minutes: 1712, avgDuration: 8, avgPercentage: 78.4, shares: 133, subscribers: 41 })
  await navigate(page, 'Analytics')
  await page.getByTestId('analytics-refresh').click()
  await expect(page.getByTestId('tile-views')).not.toContainText('indisponível')
  await shot(page, 'analytics-youtube-coletado')

  // 15. TikTok numbers typed in on the content page.
  await page.locator('[data-testid="content-row"]').first().click()
  const form = page.locator('[data-testid="manual-metrics"][data-account="@mma.cortes"]')
  await form.getByTestId('manual-views').fill('31,2 mil')
  await form.getByTestId('manual-likes').fill('2900')
  await form.getByTestId('manual-comments').fill('188')
  await form.getByTestId('manual-shares').fill('410')
  await form.getByTestId('manual-followersGained').fill('95')
  await form.getByTestId('manual-metrics-save').click()
  await expect(page.getByTestId('performance-table')).toContainText('31.200')
  await shot(page, 'desempenho-do-conteudo')

  // 16. Overview with both platforms.
  await page.getByTestId('performance-back').click()
  await expect(page.locator('[data-testid="compare-bars"] [data-testid="bar-row"]').first()).toHaveAttribute('data-key', 'TikTok')
  await shot(page, 'analytics-comparando-plataformas')

  // 17. Comments arrive; answer one.
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
  google.threads.push(
    { id: 'c1', videoId, canReply: true, top: { id: 'c1', text: 'Qual é o nome desse lutador?', author: 'Rafa', authorChannelId: 'UCr', publishedAt: ago(50) }, replies: [] },
    { id: 'c2', videoId, canReply: true, top: { id: 'c2', text: 'Que nocaute absurdo 😱', author: 'Lu', authorChannelId: 'UCl', publishedAt: ago(30) }, replies: [] },
    { id: 'c3', videoId, canReply: true, top: { id: 'c3', text: 'Posta o round inteiro!', author: 'Marcos', authorChannelId: 'UCm', publishedAt: ago(8) }, replies: [] }
  )
  await navigate(page, 'Inbox')
  await page.getByTestId('inbox-sync').click()
  await expect(page.getByTestId('inbox-item')).toHaveCount(3)
  await shot(page, 'inbox-comentarios-chegaram')
  await page.getByTestId('inbox-item').filter({ hasText: 'nome desse lutador' }).click()
  await page.getByTestId('reply-text').fill('É o campeão peso-leve do evento de sábado!')
  await page.getByTestId('reply-send').click()
  await expect(page.getByTestId('thread').getByTestId('thread-item')).toHaveCount(2)
  await shot(page, 'inbox-resposta-enviada')

  // 18. Dashboard at the end of the day.
  await navigate(page, 'Dashboard')
  await shot(page, 'dashboard-final')

  // Report: timings, errors in the renderer and in the app log.
  const logDir = join(dataDir, 'app-data', 'logs')
  const logErrors = existsSync(logDir)
    ? readdirSync(logDir)
        .filter((f) => f.endsWith('.log'))
        .flatMap((f) => readFileSync(join(logDir, f), 'utf8').split('\n'))
        .filter((l) => /"level":"error"/.test(l))
    : []
  const logWarnings = existsSync(logDir)
    ? readdirSync(logDir)
        .filter((f) => f.endsWith('.log'))
        .flatMap((f) => readFileSync(join(logDir, f), 'utf8').split('\n'))
        .filter((l) => /"level":"warn"/.test(l))
    : []
  writeFileSync(
    join(out, 'journey-report.json'),
    JSON.stringify({ steps, rendererErrors, logErrors, logWarnings: logWarnings.slice(0, 50), googleRequests: google.requests.length, uploads: google.uploadedVideos.length, replies: google.insertedReplies }, null, 2)
  )
  await app.close()
})

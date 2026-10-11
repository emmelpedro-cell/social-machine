import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { testTools } from '../helpers/media'
import { FakeGoogle } from '../helpers/fake-google'
import { card, launchApp, makeDataDir, navigate, openCard, openLibrary, stubOpenDialog } from '../e2e/helpers'

/**
 * Not a test: drives the real app through a realistic session and saves
 * screenshots of each screen to screenshots/ (run by the "Screenshots" workflow).
 */
const out = resolve('screenshots')
const dataDir = makeDataDir('screenshots')
const footage = join(dataDir, 'footage')
const dropOutput = join(dataDir, 'drop-machine', 'public', 'output')
const google = new FakeGoogle()

test.setTimeout(10 * 60_000)

function clip(name: string, source: string, size: string) {
  const tools = testTools()!
  execFileSync(tools.ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `${source}${source.includes('=') ? ':' : '='}size=${size}:rate=30`,
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6',
    '-t', '6', '-c:v', 'libopenh264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart',
    name
  ])
}

async function shot(page: Page, name: string, options: { top?: boolean } = {}) {
  // Notices fade out on their own; close them so they don't cover the screen.
  for (const close of await page.locator('.notice-close').all()) await close.click().catch(() => undefined)
  if (options.top !== false) {
    await page.evaluate(() => document.querySelectorAll('.main, .library-main, .asset-detail').forEach((el) => el.scrollTo(0, 0)))
  }
  await page.waitForTimeout(700)
  await page.screenshot({ path: join(out, `${name}.png`) })
}

async function stubBrowser(app: ElectronApplication) {
  await app.evaluate(({ shell }, approveUrl) => {
    shell.openExternal = (async (url: string) => {
      if (url.includes('/auth?')) await fetch(`${approveUrl}?url=${encodeURIComponent(url)}`)
    }) as typeof shell.openExternal
  }, google.endpoints.auth.replace('/auth', '/__approve'))
}

test.beforeAll(async () => {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  mkdirSync(footage, { recursive: true })
  mkdirSync(dropOutput, { recursive: true })
  clip(join(footage, 'Golaço de bicicleta.mp4'), 'gradients=n=4:speed=0.02', '1280x720')
  clip(join(footage, 'Enterrada no último segundo.mp4'), 'colorspectrum', '720x1280')
  clip(join(footage, 'Kickflip escada.mp4'), 'life=mold=10:ratio=0.3:death_color=#1b1b3a:life_color=#00e5ff', '1280x720')
  clip(join(footage, 'Cesta de três.mp4'), 'sierpinski', '1280x720')
  await google.start()
})

test.afterAll(async () => {
  await google.stop()
})

test('screenshots', async () => {
  const { app, page } = await launchApp(dataDir, { env: { SM_GOOGLE_ENDPOINTS: JSON.stringify(google.endpoints) } })
  await stubBrowser(app)
  // A typical laptop window (the workflow raises the runner's screen resolution first).
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    win.setContentSize(1440, 900)
    win.center()
  })

  // Projects.
  await navigate(page, 'Projetos')
  await page.getByTestId('create-suggested').click()
  await expect(page.getByTestId('project-item')).toHaveCount(4)
  const projects = await page.evaluate(() => window.sm.projects.list())
  if (!projects.ok) throw new Error(projects.error.message)
  const id = (name: string) => projects.data.find((p) => p.name === name)!.id
  await page.evaluate(
    ({ mma }) => window.sm.projects.update({ id: mma, description: 'Nocautes e finalizações', settings: { defaultHashtags: ['#mma', '#ufc', '#luta'], captionTemplate: 'Que golpe! 🔥' } }),
    { mma: id('MMA') }
  )

  // Manual imports into projects.
  await openLibrary(page)
  for (const [project, files] of [
    ['Futebol', ['Golaço de bicicleta.mp4']],
    ['Basquete', ['Enterrada no último segundo.mp4', 'Cesta de três.mp4']],
    ['Skate', ['Kickflip escada.mp4']]
  ] as const) {
    await page.getByTestId('filter-project').selectOption({ label: project })
    await expect(page.getByTestId('import-files')).toBeEnabled({ timeout: 30_000 })
    await stubOpenDialog(app, files.map((f) => join(footage, f)))
    await page.getByTestId('import-files').click()
    for (const f of files) await expect(card(page, f)).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
  }

  // Drop Machine folder for MMA.
  await navigate(page, 'Configurações')
  await stubOpenDialog(app, [dropOutput])
  await page.getByTestId('add-drop-machine').click()
  await page.getByTestId('watch-item').getByTestId('watch-project').selectOption({ label: 'MMA' })
  clip(join(dropOutput, 'MMA Drop 001.mp4'), 'mandelbrot', '720x1280')
  clip(join(dropOutput, 'MMA Drop 002.mp4'), 'zoneplate=ku=512:kv=100:kt2=0.2', '1280x720')
  clip(join(dropOutput, 'MMA Drop 003.mp4'), 'cellauto=rule=110:full=0', '1280x720')
  await expect
    .poll(async () => {
      const list = await page.evaluate(() => window.sm.media.list())
      return list.ok ? list.data.filter((c) => c.status === 'ready').length : 0
    }, { timeout: 120_000 })
    .toBe(7)
  await page.evaluate(() => window.sm.watch.scanNow())
  await shot(page, '06-configuracoes')

  // Editor: a 9:16 version with text.
  await openLibrary(page)
  await openCard(page, 'Golaço de bicicleta.mp4')
  await page.getByTestId('open-editor').click()
  await page.getByTestId('frame-zoom').fill('1.15')
  await page.getByTestId('tab-texts').click()
  await page.getByTestId('add-text').click()
  await page.getByTestId('text-content').fill('GOLAÇO DE BICICLETA')
  await page.getByTestId('text-font').selectOption({ label: 'Anton' })
  await page.getByTestId('text-size').fill('0.06')
  await page.getByTestId('tab-export').click()
  await page.getByTestId('version-name').fill('Clean 9:16')
  await page.getByTestId('export-version').click()
  await expect(page.locator('.editor-panel [data-testid="version-item"][data-name="Clean 9:16"]')).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })
  await page.getByTestId('tab-texts').click()
  await page.locator('.text-chip').first().click()
  await shot(page, '03-editor')

  // Accounts: YouTube connected (local Google stand-in) and a manual TikTok profile.
  await navigate(page, 'Contas')
  await page.getByTestId('youtube-client-id').fill('123-abc.apps.googleusercontent.com')
  await page.getByTestId('youtube-client-secret').fill('GOCSPX-demo')
  await page.getByTestId('youtube-save-credentials').click()
  await page.getByTestId('connect-youtube').click()
  const channel = page.locator('[data-testid="account-item"][data-name="MMA Cortes"]')
  await expect(channel).toHaveAttribute('data-status', 'connected', { timeout: 30_000 })
  await channel.getByRole('button', { name: 'Futebol' }).click()
  await channel.getByRole('button', { name: 'MMA' }).click()
  await page.getByTestId('manual-name-tiktok').fill('@cortes.esporte')
  await page.getByTestId('add-manual-tiktok').click()
  await expect(page.locator('[data-testid="account-item"][data-name="@cortes.esporte"]')).toBeVisible()
  await shot(page, '05-contas')

  // Publish dialog and publications.
  await openLibrary(page)
  await openCard(page, 'Golaço de bicicleta.mp4')
  await page.getByTestId('asset-detail').getByTestId('publish-version').click()
  const dialog = page.getByTestId('publish-dialog')
  await dialog.locator('[data-testid="destination"][data-account="@cortes.esporte"]').check()
  await dialog.getByTestId('publish-title').fill('Golaço de bicicleta no fim do jogo')
  await dialog.getByTestId('publish-caption').fill('Que golaço! ⚽')
  await dialog.getByTestId('publish-hashtags').fill('#futebol #gol #golaço')
  await dialog.getByTestId('kids-no').check()
  await dialog.evaluate((el) => el.scrollTo(0, 0))
  await shot(page, '07-publicar', { top: false })
  await dialog.getByTestId('publish-submit').click()
  await expect(page.getByTestId('detail-publications').locator('[data-testid="publication-item"][data-account="MMA Cortes"]')).toHaveAttribute(
    'data-status',
    'published',
    { timeout: 60_000 }
  )

  // A few scheduled posts for the queue and calendar.
  await page.evaluate(async () => {
    const contents = await window.sm.media.list()
    const accounts = await window.sm.accounts.list()
    if (!contents.ok || !accounts.ok) return
    const tiktok = accounts.data.find((a) => a.platformId === 'tiktok')!
    const youtube = accounts.data.find((a) => a.platformId === 'youtube')!
    const content = contents.data.find((c) => c.fileName === 'Golaço de bicicleta.mp4')!
    const versions = await window.sm.versions.list(content.id)
    if (!versions.ok || !versions.data[0]) return
    const day = (n: number, h: number) => {
      const d = new Date()
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, h, 0).toISOString()
    }
    const plan: [string, number, number, boolean][] = [
      [tiktok.id, 1, 12, false],
      [youtube.id, 1, 19, true],
      [tiktok.id, 3, 19, false],
      [youtube.id, 5, 12, true],
      [tiktok.id, 8, 12, false]
    ]
    for (const [accountId, n, h, yt] of plan) {
      await window.sm.publications.create({
        versionId: versions.data[0].id,
        destinations: [
          {
            accountId,
            title: 'Golaço de bicicleta no fim do jogo',
            caption: 'Que golaço! ⚽',
            hashtags: ['#futebol'],
            fields: yt ? { privacy: 'public', madeForKids: false, categoryId: '17', scheduleMode: 'local' } : {},
            scheduledAt: day(n, h)
          }
        ],
        allowRepeat: true,
        requestId: crypto.randomUUID()
      })
    }
  })
  await navigate(page, 'Fila')
  await expect(page.getByTestId('queue-day').first()).toBeVisible()
  await shot(page, '08-fila')
  await navigate(page, 'Calendário')
  await page.getByTestId('cal-item').first().click()
  await shot(page, '09-calendario')

  // Library with details open.
  await openLibrary(page)
  await page.getByTestId('filter-project').selectOption('all')
  await openCard(page, 'Golaço de bicicleta.mp4')
  await shot(page, '02-biblioteca')

  // Projects and dashboard.
  await navigate(page, 'Projetos')
  await shot(page, '04-projetos')
  await navigate(page, 'Dashboard')
  await shot(page, '01-dashboard')

  await app.close()
})

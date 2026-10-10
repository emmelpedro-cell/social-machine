import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createFixtures, testTools, type Fixtures } from '../helpers/media'
import { card, launchApp, makeDataDir, navigate, openCard, openLibrary, stubOpenDialog } from './helpers'

/**
 * Phase 1 acceptance, through the real UI of the built app:
 * - videos are imported manually into a project, with metadata, thumbnail and preview, and survive a restart;
 * - the Drop Machine output folder is watched: existing and new clips arrive on their own, only once,
 *   only after they finish being written, and without the source files being touched;
 * - closing the window keeps watching from the tray; clips created while the app was closed are found on start;
 * - contents are reviewed and organised in bulk; moved files are relinked.
 */
test.describe.configure({ mode: 'serial' })

const dataDir = makeDataDir('media')
const footage = join(dataDir, 'my-footage')
const dropOutput = join(dataDir, 'drop-machine', 'public', 'output')
let fx: Fixtures

test.beforeAll(() => {
  const tools = testTools()
  if (!tools) throw new Error('FFmpeg is required for the E2E tests. Run "npm run fetch:ffmpeg".')
  fx = createFixtures(tools, join(dataDir, 'fixtures'))
  mkdirSync(footage, { recursive: true })
  mkdirSync(dropOutput, { recursive: true })
  copyFileSync(fx.mp4, join(footage, 'Lance 1.mp4'))
  copyFileSync(fx.vertical, join(footage, 'Lance vertical.mp4'))
})

test.afterAll(() => {
  if (!process.env.SM_E2E_DATA) rmSync(dataDir, { recursive: true, force: true })
})

async function expectThumbnailLoaded(page: Page, fileName: string) {
  const img = card(page, fileName).getByTestId('asset-thumb')
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(480)
}

async function createProject(page: Page, name: string): Promise<string> {
  const result = await page.evaluate((n) => window.sm.projects.create({ name: n }), name)
  if (!result.ok) throw new Error(result.error.message)
  return result.data.id
}

/** Writes a video in chunks, like a renderer that is still producing it. */
async function writeProgressively(source: string, target: string, chunks = 6, pauseMs = 300) {
  const data = readFileSync(source)
  const size = Math.ceil(data.length / chunks)
  for (let i = 0; i < data.length; i += size) {
    appendFileSync(target, data.subarray(i, i + size))
    await new Promise((r) => setTimeout(r, pauseMs))
  }
}

async function libraryFiles(page: Page): Promise<string[]> {
  const result = await page.evaluate(() => window.sm.media.list())
  if (!result.ok) throw new Error(result.error.message)
  return result.data.map((c) => c.fileName).sort()
}

const windowVisible = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))

test('imports videos into a project, shows metadata, thumbnail and preview, and keeps them after a restart', async () => {
  let { app, page } = await launchApp(dataDir)
  await createProject(page, 'Futebol')
  await page.reload()
  await openLibrary(page)
  await expect(page.getByTestId('library-empty')).toBeVisible()

  await page.getByTestId('filter-project').selectOption({ label: 'Futebol' })
  const importButton = page.getByTestId('import-files')
  await expect(importButton).toBeEnabled({ timeout: 30_000 })
  await expect(importButton).toHaveText('Importar vídeos para Futebol…')

  await stubOpenDialog(app, [join(footage, 'Lance 1.mp4'), join(footage, 'Lance vertical.mp4')])
  await importButton.click()

  const landscape = card(page, 'Lance 1.mp4')
  const vertical = card(page, 'Lance vertical.mp4')
  await expect(landscape).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
  await expect(vertical).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })

  // Metadata from FFprobe, including the aspect ratio.
  await expect(landscape.getByTestId('asset-meta')).toHaveText('0:02 · 320×240 · 4:3 · 30 fps')
  await expect(vertical.getByTestId('asset-meta')).toHaveText('0:02 · 180×320 · 9:16 · 30 fps')
  await expect(vertical).toContainText('Futebol')
  await expect(vertical).toHaveAttribute('data-workflow', 'imported')
  await expectThumbnailLoaded(page, 'Lance vertical.mp4')

  // Details and preview: streamed through sm-media:// and decoded by Electron.
  await openCard(page, 'Lance vertical.mp4')
  const facts = page.getByTestId('asset-facts')
  await expect(facts).toContainText('180 × 320')
  await expect(facts).toContainText('9:16')
  await expect(facts).toContainText('h264')
  await expect(facts).toContainText(join(footage, 'Lance vertical.mp4'))
  const video = page.getByTestId('preview-video')
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(1)
  expect(await video.evaluate((el: HTMLVideoElement) => [el.videoWidth, el.videoHeight])).toEqual([180, 320])

  // Title and status are editable from the details panel.
  await page.getByTestId('content-title').fill('Golaço de bicicleta')
  await page.getByTestId('content-title').press('Enter')
  await page.getByTestId('content-workflow').selectOption('ready')
  await expect(vertical).toHaveAttribute('data-workflow', 'ready')
  await expect(vertical).toContainText('Golaço de bicicleta')
  await app.close()

  // Restart: everything is still there.
  ;({ app, page } = await launchApp(dataDir))
  await openLibrary(page)
  await expect(card(page, 'Lance 1.mp4')).toHaveAttribute('data-state', 'ready')
  await expect(card(page, 'Lance vertical.mp4')).toHaveAttribute('data-workflow', 'ready')
  await expect(card(page, 'Lance vertical.mp4')).toContainText('Golaço de bicicleta')
  await expectThumbnailLoaded(page, 'Lance 1.mp4')

  // Importing the same files again adds nothing.
  await stubOpenDialog(app, [join(footage, 'Lance 1.mp4'), join(footage, 'Lance vertical.mp4')])
  await page.getByTestId('import-files').click()
  await expect(page.getByRole('status').filter({ hasText: 'já estão na biblioteca' })).toBeVisible()
  await expect(page.getByTestId('asset-card')).toHaveCount(2)
  await app.close()
})

test('watches the Drop Machine output folder: existing and new clips arrive once, after they finish', async () => {
  // A clip that was already rendered before the folder was configured.
  copyFileSync(fx.mov, join(dropOutput, 'MMA Drop 001.mov'))
  const sourceStat = statSync(join(dropOutput, 'MMA Drop 001.mov'))

  const { app, page } = await launchApp(dataDir)
  const mma = await createProject(page, 'MMA')
  await page.reload()
  await navigate(page, 'Configurações')
  await stubOpenDialog(app, [dropOutput])
  await page.getByTestId('add-drop-machine').click()

  const folderItem = page.getByTestId('watch-item')
  await expect(folderItem).toHaveCount(1)
  await expect(folderItem.getByTestId('watch-state')).toHaveText('Monitorando')
  await folderItem.getByTestId('watch-project').selectOption({ label: 'MMA' })

  // The clip that was already in the folder is imported too.
  await expect.poll(() => libraryFiles(page), { timeout: 60_000 }).toContain('MMA Drop 001.mov')

  // A new clip, written over a couple of seconds, goes to MMA as "needs review", once.
  await writeProgressively(fx.vertical, join(dropOutput, 'MMA Drop 002.mp4'))
  await openLibrary(page)
  const fresh = card(page, 'MMA Drop 002.mp4')
  await expect(fresh).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
  await expect(fresh).toHaveAttribute('data-workflow', 'needs_review')
  await expect(fresh).toContainText('MMA')
  await expect(fresh.getByTestId('asset-meta')).toHaveText('0:02 · 180×320 · 9:16 · 30 fps')
  await expect(page.getByTestId('nav-badge-library')).toHaveText('2')

  const contents = await page.evaluate(() => window.sm.media.list())
  if (!contents.ok) throw new Error(contents.error.message)
  const drop = contents.data.find((c) => c.fileName === 'MMA Drop 002.mp4')!
  expect(drop).toMatchObject({ origin: 'drop_machine', projectId: mma, workflowStatus: 'needs_review' })
  expect(contents.data.filter((c) => c.fileName === 'MMA Drop 002.mp4')).toHaveLength(1)

  // Nothing in the watched folder was changed.
  expect(statSync(join(dropOutput, 'MMA Drop 001.mov')).mtimeMs).toBe(sourceStat.mtimeMs)
  expect(existsSync(join(dropOutput, 'MMA Drop 002.mp4'))).toBe(true)

  // The dashboard shows the review count and the folder state.
  await navigate(page, 'Dashboard')
  await expect(page.getByTestId('tile-review')).toContainText('2')
  await expect(page.getByTestId('dash-watch')).toContainText('Monitorando')
  await app.close()
})

test('keeps watching in the tray after the window is closed, and catches up on start', async () => {
  let { app, page } = await launchApp(dataDir)
  const trayAvailable = await page.evaluate(async () => {
    const info = await window.sm.app.getInfo()
    return info.ok && info.data.trayAvailable
  })
  if (!trayAvailable) {
    await app.close()
    test.skip(true, 'No system tray in this session')
  }

  // Closing the window hides it; the app keeps running.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
  await expect.poll(() => windowVisible(app)).toEqual([false])

  copyFileSync(fx.otherMp4, join(dropOutput, 'MMA Drop 003.mp4'))
  // The hidden window's page still works, so the library can be queried while it is in the tray.
  await expect.poll(() => libraryFiles(page), { timeout: 60_000 }).toContain('MMA Drop 003.mp4')
  await app.close()

  // While the app is completely closed, nothing is watched...
  copyFileSync(fx.rotatedMp4, join(dropOutput, 'MMA Drop 004.mp4'))
  // ...and on the next start the folder is reconciled.
  ;({ app, page } = await launchApp(dataDir))
  await expect.poll(() => libraryFiles(page), { timeout: 60_000 }).toContain('MMA Drop 004.mp4')
  await openLibrary(page)
  await expect(card(page, 'MMA Drop 004.mp4')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
  await app.close()
})

test('reviews and organises contents in bulk', async () => {
  const { app, page } = await launchApp(dataDir)
  await openLibrary(page)
  await page.getByTestId('filter-workflow').selectOption('needs_review')
  const cards = page.getByTestId('asset-card')
  await expect(cards.first()).toBeVisible()
  const count = await cards.count()
  expect(count).toBeGreaterThanOrEqual(2)

  await card(page, 'MMA Drop 002.mp4').locator('.asset-check input').click()
  await card(page, 'MMA Drop 001.mov').locator('.asset-check input').click()
  await expect(page.getByTestId('bulk-bar')).toContainText('2 selecionados')
  await page.getByTestId('bulk-workflow').selectOption('ready')
  await expect(page.getByRole('status').filter({ hasText: '2 conteúdos marcados como “Pronto”' })).toBeVisible()
  // They leave the "needs review" view.
  await expect(cards).toHaveCount(count - 2)

  // Moving clips to another project.
  await createProject(page, 'Boxe')
  await page.reload()
  await openLibrary(page)
  await page.getByTestId('filter-project').selectOption({ label: 'MMA' })
  await card(page, 'MMA Drop 002.mp4').locator('.asset-check input').click()
  await page.getByTestId('bulk-project').selectOption({ label: 'Boxe' })
  await expect(card(page, 'MMA Drop 002.mp4')).toHaveCount(0)
  await page.getByTestId('filter-project').selectOption({ label: 'Boxe' })
  await expect(card(page, 'MMA Drop 002.mp4')).toBeVisible()
  await expect(card(page, 'MMA Drop 002.mp4')).toContainText('Boxe')
  await app.close()
})

test('flags a moved file as missing and relinks it', async () => {
  const moved = join(footage, 'moved')
  mkdirSync(moved, { recursive: true })
  renameSync(join(footage, 'Lance 1.mp4'), join(moved, 'Lance 1.mp4'))

  const { app, page } = await launchApp(dataDir)
  await openLibrary(page)
  const landscape = card(page, 'Lance 1.mp4')
  await expect(landscape).toHaveAttribute('data-state', 'missing', { timeout: 20_000 })
  await expect(page.getByTestId('missing-banner')).toBeVisible()
  // Metadata and thumbnail are kept while the file is missing.
  await expect(landscape.getByTestId('asset-meta')).toHaveText('0:02 · 320×240 · 4:3 · 30 fps')

  await openCard(page, 'Lance 1.mp4')
  await stubOpenDialog(app, [join(moved, 'Lance 1.mp4')])
  await page.getByTestId('relink').click()
  await expect(landscape).toHaveAttribute('data-state', 'ready')
  await expect(page.getByTestId('missing-banner')).toHaveCount(0)
  await expect(page.getByTestId('asset-facts')).toContainText(join(moved, 'Lance 1.mp4'))
  await app.close()
})

test('imports files handed over the drag-and-drop path and reports invalid media clearly', async () => {
  const mov = join(footage, 'Bastidores.mov')
  const broken = join(footage, 'export-quebrado.mp4')
  const audio = join(footage, 'trilha.wav')
  copyFileSync(fx.mov, mov)
  copyFileSync(fx.corrupt, broken)
  copyFileSync(fx.wav, audio)

  const { app, page } = await launchApp(dataDir)
  await openLibrary(page)
  await expect(page.getByTestId('import-files')).toBeEnabled({ timeout: 30_000 })

  // Real File objects, as a drop would produce; the preload resolves their paths.
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.id = 'e2e-files'
    input.style.display = 'none'
    document.body.append(input)
  })
  await page.setInputFiles('#e2e-files', [mov, broken, audio])
  const result = await page.evaluate(async () => {
    const input = document.getElementById('e2e-files') as HTMLInputElement
    return window.sm.media.importDropped(Array.from(input.files ?? []))
  })
  expect(result).toMatchObject({ ok: true, data: { queued: 3 } })

  await expect(card(page, 'Bastidores.mov')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
  await expect(card(page, 'Bastidores.mov').getByTestId('asset-meta')).toHaveText('0:02 · 640×360 · 16:9 · 25 fps')

  const brokenCard = card(page, 'export-quebrado.mp4')
  await expect(brokenCard).toHaveAttribute('data-state', 'error', { timeout: 60_000 })
  await expect(brokenCard.getByTestId('asset-meta')).toContainText('não é um arquivo de vídeo legível')
  await expect(card(page, 'trilha.wav').getByTestId('asset-meta')).toContainText('apenas vídeos')

  // The renderer can't smuggle in arbitrary paths: plain strings are rejected.
  const forged = await page.evaluate(() => window.sm.media.importDropped([new File(['x'], 'C:\\Windows\\win.ini')]))
  expect(forged.ok).toBe(false)
  await app.close()
})

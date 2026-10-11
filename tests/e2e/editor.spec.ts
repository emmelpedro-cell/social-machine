import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ContentVersion } from '../../src/shared/editor'
import { createFixtures, testTools, type Fixtures } from '../helpers/media'
import { card, launchApp, makeDataDir, openCard, openLibrary, stubOpenDialog } from './helpers'

/**
 * Phase 2 acceptance, through the real UI: a clip is opened in the editor,
 * reframed to 9:16 with a text, exported as a version (real FFmpeg render,
 * text drawn by the editor's canvas), the original stays untouched, and the
 * version is listed, playable and still there after a restart.
 */
test.describe.configure({ mode: 'serial' })

const dataDir = makeDataDir('editor')
const footage = join(dataDir, 'footage')
let fx: Fixtures
let clip: string
let originalHash: string
const tools = testTools()

test.beforeAll(() => {
  if (!tools) throw new Error('FFmpeg is required for the E2E tests. Run "npm run fetch:ffmpeg".')
  fx = createFixtures(tools, join(dataDir, 'fixtures'))
  mkdirSync(footage, { recursive: true })
  clip = join(footage, 'Nocaute.mp4')
  copyFileSync(fx.mp4, clip)
  originalHash = createHash('sha256').update(readFileSync(clip)).digest('hex')
})

test.afterAll(() => {
  if (!process.env.SM_E2E_DATA) rmSync(dataDir, { recursive: true, force: true })
})

function pixel(file: string, t: number, x: number, y: number): number[] {
  const out = execFileSync(
    tools!.ffmpeg,
    ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${x - (x % 2)}:${y - (y % 2)}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1024 }
  )
  return [out[0]!, out[1]!, out[2]!]
}

test('edits a clip into a 9:16 version with text and exports it', async () => {
  const { app, page } = await launchApp(dataDir)
  const created = await page.evaluate(() => window.sm.projects.create({ name: 'MMA' }))
  expect(created.ok).toBe(true)
  await page.reload()

  await openLibrary(page)
  await page.getByTestId('filter-project').selectOption({ label: 'MMA' })
  await expect(page.getByTestId('import-files')).toBeEnabled({ timeout: 30_000 })
  await stubOpenDialog(app, [clip])
  await page.getByTestId('import-files').click()
  await expect(card(page, 'Nocaute.mp4')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })

  await openCard(page, 'Nocaute.mp4')
  await page.getByTestId('open-editor').click()

  // 9:16 by default, previewed at the export size.
  const stage = page.getByTestId('editor-stage')
  await expect(stage).toHaveAttribute('data-output', '1080x1920')
  await expect(page.getByTestId('output-size')).toHaveText('Saída: 1080×1920 px')
  const video = page.getByTestId('editor-video')
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(1)

  // Zoom in a little: the preview follows.
  await page.getByTestId('frame-zoom').fill('1.2')

  // A text with a black box behind it.
  await page.getByTestId('tab-texts').click()
  await page.getByTestId('add-text').click()
  await page.getByTestId('text-content').fill('KO NO 1º ROUND')
  await page.getByTestId('text-font').selectOption({ label: 'Anton' })
  await page.getByTestId('text-editor').getByText('Caixa de fundo').click()

  // Export.
  await page.getByTestId('tab-export').click()
  await page.getByTestId('version-name').fill('Clean 9:16')
  await page.getByTestId('export-version').click()
  const item = page.locator('.editor-panel [data-testid="version-item"][data-name="Clean 9:16"]')
  await expect(item).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })
  await expect(item).toContainText('1080×1920')
  await expect(item).toContainText('9:16')

  // The version on disk: real H.264 MP4 at 1080×1920, with the editor's text box burned in.
  const contents = await page.evaluate(() => window.sm.media.list())
  if (!contents.ok) throw new Error(contents.error.message)
  const content = contents.data.find((c) => c.fileName === 'Nocaute.mp4')!
  expect(content.workflowStatus).toBe('editing')
  const listed = await page.evaluate((id) => window.sm.versions.list(id), content.id)
  if (!listed.ok) throw new Error(listed.error.message)
  const version = listed.data[0] as ContentVersion
  expect(version).toMatchObject({ status: 'ready', width: 1080, height: 1920 })
  expect(version.filePath).toContain(join('exports', 'MMA'))
  expect(existsSync(version.filePath!)).toBe(true)

  // Inside the box's top padding, above the letters: black (the box), not the clip's colours.
  const [r, g, b] = pixel(version.filePath!, 1, 540, Math.round(0.22 * 1920 - 0.045 * 1920 * 0.59 - 0.045 * 1920 * 0.1))
  expect(Math.max(r!, g!, b!)).toBeLessThan(45)

  // The original was only read.
  expect(createHash('sha256').update(readFileSync(clip)).digest('hex')).toBe(originalHash)

  // Save the style as a preset for the project.
  await page.getByTestId('preset-name').fill('Título com caixa')
  await page.getByTestId('save-preset').click()
  await expect(page.getByTestId('apply-preset')).toHaveText('Título com caixa')

  // The version plays in the app.
  await item.getByRole('button', { name: 'Assistir' }).click()
  const player = item.getByTestId('version-player')
  await expect.poll(() => player.evaluate((el: HTMLVideoElement) => el.videoHeight), { timeout: 20_000 }).toBe(1920)
  await app.close()
})

test('keeps versions after a restart and shows them in the library', async () => {
  const { app, page } = await launchApp(dataDir)
  await openLibrary(page)
  const c = card(page, 'Nocaute.mp4')
  await expect(c.getByTestId('asset-versions')).toContainText('1 versão')
  await openCard(page, 'Nocaute.mp4')
  const detailItem = page.getByTestId('asset-detail').getByTestId('version-item')
  await expect(detailItem).toHaveAttribute('data-status', 'ready')
  await expect(detailItem).toHaveAttribute('data-name', 'Clean 9:16')

  // A second version from a preset, in another format, then cancelled-free delete keeping the file.
  await page.getByTestId('open-editor').click()
  await page.getByTestId('tab-export').click()
  await page.getByTestId('apply-preset').click()
  await page.getByTestId('tab-frame').click()
  await page.getByTestId('output-preset').selectOption('1:1')
  await expect(page.getByTestId('editor-stage')).toHaveAttribute('data-output', '1080x1080')
  await page.getByTestId('tab-export').click()
  await expect(page.getByTestId('version-name')).toHaveValue('Versão A')
  await page.getByTestId('export-version').click()
  const square = page.locator('.editor-panel [data-testid="version-item"][data-name="Versão A"]')
  await expect(square).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })
  await expect(square).toContainText('1080×1080')
  await app.close()
})

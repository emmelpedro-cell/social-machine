import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createFixtures, testTools } from '../helpers/media'
import { card, launchApp, makeDataDir, openLibrary, stubOpenDialog } from '../e2e/helpers'

/**
 * Runs against the unpacked Windows build produced by `npm run dist:win`,
 * proving that FFmpeg is bundled, found and working in the installed layout.
 */
const exe = resolve(process.env.SM_PACKAGED_EXE ?? join('dist', 'win-unpacked', 'Social Machine.exe'))
const ffmpegDir = join(dirname(exe), 'resources', 'ffmpeg')

// Locally a missing build just skips; in CI it must fail, so a green run proves the packaged app was tested.
if (process.env.CI && !existsSync(exe)) throw new Error(`Packaged app not found at ${exe}.`)
test.skip(!existsSync(exe), `Packaged app not found at ${exe}. Run "npm run dist:win" first.`)

const dataDir = makeDataDir('packaged')

test.afterAll(() => {
  if (!process.env.SM_E2E_DATA) rmSync(dataDir, { recursive: true, force: true })
})

test('ships FFmpeg with its license notices and without ffplay', () => {
  for (const file of ['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'LICENSE.txt', 'COPYING.GPLv3', 'FFMPEG-LICENSE.md', 'NOTICE.txt', 'manifest.json']) {
    expect(existsSync(join(ffmpegDir, file)), file).toBe(true)
  }
  expect(existsSync(join(ffmpegDir, 'bin', 'ffplay.exe'))).toBe(false)
  const manifest = JSON.parse(readFileSync(join(ffmpegDir, 'manifest.json'), 'utf8')) as { license: string }
  expect(manifest.license).toBe('LGPL-3.0-or-later')
  expect(readFileSync(join(ffmpegDir, 'LICENSE.txt'), 'utf8')).toContain('GNU LESSER GENERAL PUBLIC LICENSE')

  // The bundled build reports an LGPL configuration (no --enable-gpl / --enable-nonfree).
  const version = execFileSync(join(ffmpegDir, 'bin', 'ffmpeg.exe'), ['-hide_banner', '-version'], { encoding: 'utf8' })
  expect(version).not.toContain('--enable-gpl')
  expect(version).not.toContain('--enable-nonfree')
  expect(version).toContain('--enable-version3')
})

test('the installed app finds and verifies its bundled FFmpeg, and imports a video', async () => {
  const { app, page } = await launchApp(dataDir, { executablePath: exe })
  const status = await page.evaluate(() => window.sm.media.toolsStatus())
  expect(status.ok).toBe(true)
  if (!status.ok || !status.data.ok) throw new Error(JSON.stringify(status))
  expect(status.data.source).toBe('packaged')
  expect(status.data.directory.toLowerCase()).toBe(ffmpegDir.toLowerCase())
  expect(status.data.license).toBe('LGPL-3.0-or-later')

  const tools = testTools()
  if (!tools) throw new Error('FFmpeg is required to create test media.')
  const fx = createFixtures(tools, join(dataDir, 'fixtures'))
  const clip = join(dataDir, 'footage', 'Packaged test.mp4')
  mkdirSync(dirname(clip), { recursive: true })
  copyFileSync(fx.mp4, clip)

  await openLibrary(page)
  await expect(page.getByTestId('import-files')).toBeEnabled()
  await stubOpenDialog(app, [clip])
  await page.getByTestId('import-files').click()
  await expect(card(page, 'Packaged test.mp4')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
  await expect(card(page, 'Packaged test.mp4').getByTestId('asset-meta')).toHaveText('0:02 · 320×240 · 4:3 · 30 fps')
  const img = card(page, 'Packaged test.mp4').getByTestId('asset-thumb')
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(480)
  await app.close()
})

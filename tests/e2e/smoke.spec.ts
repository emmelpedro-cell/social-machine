import { expect, test } from '@playwright/test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeDataDir, navigate } from './helpers'

/**
 * The app launches on a clean data folder, creates its database, and
 * projects saved in one session are still there after a restart.
 * Requires a build first (`npm run test:e2e` does both).
 */
const dataDir = makeDataDir('smoke')

test.afterAll(() => {
  if (!process.env.SM_E2E_DATA) rmSync(dataDir, { recursive: true, force: true })
})

test('creates projects and finds them again after a restart', async () => {
  const first = await launchApp(dataDir)
  await expect(first.page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  expect(existsSync(join(dataDir, 'app-data', 'database.sqlite'))).toBe(true)

  await navigate(first.page, 'Projetos')
  await expect(first.page.getByTestId('projects-empty')).toBeVisible()
  await first.page.getByTestId('create-suggested').click()
  const items = first.page.getByTestId('project-item')
  await expect(items).toHaveCount(4)
  await expect(items.first()).toHaveAttribute('data-name', 'Basquete')

  // A custom project, then editing its default hashtags.
  await first.page.getByTestId('new-project').click()
  await first.page.getByTestId('project-name').fill('Surf')
  await first.page.getByTestId('project-submit').click()
  await expect(items).toHaveCount(5)
  await first.page.locator('[data-testid="project-item"][data-name="MMA"]').getByRole('button', { name: 'Editar' }).click()
  await first.page.getByTestId('project-hashtags').fill('mma, #ufc  #luta')
  await first.page.getByTestId('project-submit').click()
  await expect(first.page.getByRole('status').filter({ hasText: 'Projeto “MMA” salvo' })).toBeVisible()
  await first.app.close()

  const second = await launchApp(dataDir)
  await navigate(second.page, 'Projetos')
  await expect(second.page.getByTestId('project-item')).toHaveCount(5)
  const projects = await second.page.evaluate(() => window.sm.projects.list())
  expect(projects.ok).toBe(true)
  if (!projects.ok) return
  expect(projects.data.find((p) => p.name === 'MMA')?.settings.defaultHashtags).toEqual(['#mma', '#ufc', '#luta'])
  await second.app.close()
})

test('the renderer has no access to Node or ipcRenderer', async () => {
  const { app, page } = await launchApp(dataDir)
  const exposure = await page.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>)['require'],
    process: typeof (globalThis as Record<string, unknown>)['process'],
    api: Object.keys(window.sm).sort()
  }))
  expect(exposure).toEqual({
    require: 'undefined',
    process: 'undefined',
    api: ['accounts', 'analytics', 'app', 'editor', 'log', 'media', 'platforms', 'presets', 'projects', 'publications', 'queue', 'settings', 'versions', 'watch', 'youtube']
  })
  await app.close()
})

test('the media protocol only serves library contents', async () => {
  const { app, page } = await launchApp(dataDir)
  const statuses = await page.evaluate(async () => {
    const urls = [
      'sm-media://asset/00000000-0000-4000-8000-000000000000',
      'sm-media://asset/..%2F..%2Fapp-data%2Fdatabase.sqlite',
      'sm-media://file/C:/Windows/win.ini'
    ]
    return Promise.all(urls.map((u) => fetch(u).then((r) => r.status, () => 0)))
  })
  for (const status of statuses) expect(status === 0 || status >= 400).toBe(true)
  await app.close()
})

test('later-phase areas say what is coming instead of showing fake controls', async () => {
  const { app, page } = await launchApp(dataDir)
  for (const [label, heading] of [
    ['Inbox', 'Inbox']
  ] as const) {
    await navigate(page, label)
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    await expect(page.getByText(/Chega na Fase \d/).first()).toBeVisible()
  }
  await app.close()
})

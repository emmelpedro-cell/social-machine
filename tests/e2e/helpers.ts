import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A data folder for one test file. In CI (SM_E2E_DATA set) it lives in the
 * workspace so the app's logs can be uploaded when a test fails.
 */
export function makeDataDir(name: string): string {
  const base = process.env.SM_E2E_DATA
  if (base) {
    const dir = join(base, name)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  return mkdtempSync(join(tmpdir(), `sm-e2e-${name}-`))
}

export async function launchApp(
  dataDir: string,
  options: { executablePath?: string } = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    ...(options.executablePath ? { executablePath: options.executablePath, args: [] } : { args: ['.'] }),
    env: { ...process.env, SM_DATA_DIR: dataDir, NODE_ENV: 'test' }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/** Replaces the native open dialog with one that "selects" the given paths. */
export async function stubOpenDialog(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: selected })) as typeof dialog.showOpenDialog
  }, paths)
}

export async function navigate(page: Page, label: string): Promise<void> {
  await page.getByRole('navigation').getByRole('button', { name: label, exact: false }).first().click()
}

export async function openLibrary(page: Page): Promise<void> {
  await navigate(page, 'Biblioteca')
}

export const card = (page: Page, fileName: string) => page.locator(`[data-testid="asset-card"][data-file-name="${fileName}"]`)

/** Opens a card's details panel. */
export async function openCard(page: Page, fileName: string): Promise<void> {
  await card(page, fileName).locator('.asset-card-body').click()
}

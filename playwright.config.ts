import { defineConfig } from '@playwright/test'

export default defineConfig({
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  // In CI, failures become annotations on the workflow run, plus a summary of every test's outcome.
  reporter: process.env.CI ? [['github'], ['list'], ['./tests/summary-reporter-playwright.ts']] : 'list',
  projects: [
    // The built app run from the project folder (`npm run test:e2e`).
    { name: 'dev', testDir: './tests/e2e' },
    // The unpacked Windows build (`npm run dist:win`, then `npm run test:packaged`).
    { name: 'packaged', testDir: './tests/e2e-packaged' },
    // Not a test suite: captures screenshots of the real app (`Screenshots` workflow).
    { name: 'screenshots', testDir: './tests/screenshots' }
  ]
})

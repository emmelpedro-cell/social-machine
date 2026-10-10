import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    // Tests use Node's built-in SQLite driver, not better-sqlite3, because
    // better-sqlite3 is compiled for Electron's ABI after `npm install`.
    pool: 'forks',
    // Media tests run real FFmpeg processes.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // In CI: annotations for failures and a summary of what ran.
    reporters: process.env.GITHUB_ACTIONS ? ['default', 'github-actions', './tests/summary-reporter-vitest.ts'] : ['default']
  }
})

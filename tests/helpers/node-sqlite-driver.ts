import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SqlDriver, SqlValue } from '../../src/main/db/driver'
import type { Logger } from '../../src/main/logger'

// Loaded via require so the test bundler leaves Node's built-in module alone.
const require = createRequire(import.meta.url)
type NodeSqlite = typeof import('node:sqlite')
const { DatabaseSync } = require('node:sqlite') as NodeSqlite

/** Test driver backed by Node's built-in SQLite (Node >= 22.13). */
export function createNodeSqliteDriver(path = ':memory:'): SqlDriver {
  const db = new DatabaseSync(path)
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const st = db.prepare(sql)
      return {
        run: (...p: SqlValue[]) => st.run(...p),
        get: (...p: SqlValue[]) => st.get(...p),
        all: (...p: SqlValue[]) => st.all(...p)
      }
    },
    close: () => db.close()
  }
}

export function tempDir(prefix = 'sm-test-'): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix))
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

export type CapturedLog = { level: string; message: string; context?: Record<string, unknown> }

/** In-memory logger for assertions. */
export function memoryLogger(): Logger & { entries: CapturedLog[] } {
  const entries: CapturedLog[] = []
  const make = (): Logger & { entries: CapturedLog[] } => ({
    entries,
    filePath: '(memory)',
    debug: (message, context) => entries.push({ level: 'debug', message, context }),
    info: (message, context) => entries.push({ level: 'info', message, context }),
    warn: (message, context) => entries.push({ level: 'warn', message, context }),
    error: (message, context) => entries.push({ level: 'error', message, context }),
    child: () => make()
  })
  return make()
}

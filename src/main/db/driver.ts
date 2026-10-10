/**
 * Minimal synchronous SQLite interface.
 *
 * The app uses better-sqlite3 inside Electron. Unit tests use Node's built-in
 * `node:sqlite`, because better-sqlite3 is compiled for Electron's ABI after
 * install and cannot be loaded by plain Node. Both satisfy this interface.
 *
 * Use positional `?` parameters only: the two drivers differ on named ones.
 */
export type SqlValue = string | number | bigint | null | Uint8Array

export interface SqlStatement {
  run(...params: SqlValue[]): { changes: number | bigint }
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown[]
}

export interface SqlDriver {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  close(): void
}

/**
 * Runs `fn` inside a transaction. Nested calls use savepoints, so a
 * repository method can be called both standalone and from a larger unit.
 */
let savepointCounter = 0
const depth = new WeakMap<SqlDriver, number>()

export function transaction<T>(db: SqlDriver, fn: () => T): T {
  const level = depth.get(db) ?? 0
  const savepoint = `sp_${++savepointCounter}`
  db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
  depth.set(db, level + 1)
  try {
    const result = fn()
    db.exec(level === 0 ? 'COMMIT' : `RELEASE ${savepoint}`)
    return result
  } catch (error) {
    db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
    throw error
  } finally {
    depth.set(db, level)
  }
}

export function applyConnectionPragmas(db: SqlDriver): void {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
}

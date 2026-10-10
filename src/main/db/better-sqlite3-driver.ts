import Database from 'better-sqlite3'
import type { SqlDriver, SqlValue } from './driver'

/** Production driver used inside Electron. */
export function createBetterSqliteDriver(path: string): SqlDriver {
  const db = new Database(path)
  return {
    exec: (sql) => {
      db.exec(sql)
    },
    prepare: (sql) => {
      const statement = db.prepare(sql)
      // Note: better-sqlite3 only allows get()/all() on statements that return rows.
      return {
        run: (...params: SqlValue[]) => statement.run(...params),
        get: (...params: SqlValue[]) => statement.get(...params),
        all: (...params: SqlValue[]) => statement.all(...params)
      }
    },
    close: () => {
      db.close()
    }
  }
}

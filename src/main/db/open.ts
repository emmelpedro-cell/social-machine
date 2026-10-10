import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { applyConnectionPragmas, type SqlDriver } from './driver'
import { MIGRATIONS, currentSchemaVersion, pendingMigrations, runMigrations, type Migration } from './migrations'
import type { Logger } from '../logger'

export type OpenDatabaseOptions = {
  databasePath: string
  backupsDirectory: string
  createDriver: (path: string) => SqlDriver
  logger: Logger
  migrations?: readonly Migration[]
  /** How many pre-migration backups to keep. */
  keepBackups?: number
}

export type OpenedDatabase = {
  db: SqlDriver
  schemaVersion: number
  backupPath: string | null
}

/**
 * Opens the database, backs it up if migrations are pending on an existing
 * file, and migrates it. Backups are written with `VACUUM INTO`, which yields
 * a consistent single-file copy even in WAL mode.
 */
export function openDatabase(options: OpenDatabaseOptions): OpenedDatabase {
  const { databasePath, backupsDirectory, createDriver, logger } = options
  const migrations = options.migrations ?? MIGRATIONS
  const existed = existsSync(databasePath) && statSync(databasePath).size > 0

  const db = createDriver(databasePath)
  try {
    applyConnectionPragmas(db)

    const pending = pendingMigrations(db, migrations)
    let backupPath: string | null = null

    if (existed && pending.length > 0) {
      const from = currentSchemaVersion(db)
      mkdirSync(backupsDirectory, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      backupPath = join(backupsDirectory, `database-v${from}-${stamp}.sqlite`)
      db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
      logger.info('Database backed up before migration', { backupPath, from })
      pruneBackups(backupsDirectory, options.keepBackups ?? 10, logger)
    }

    const result = runMigrations(db, migrations)
    if (result.applied.length) {
      logger.info('Database migrated', result)
    }
    return { db, schemaVersion: result.to, backupPath }
  } catch (error) {
    db.close()
    throw error
  }
}

function pruneBackups(directory: string, keep: number, logger: Logger): void {
  const backups = readdirSync(directory)
    .filter((f) => /^database-v\d+-.*\.sqlite$/.test(f))
    .map((f) => ({ f, t: statSync(join(directory, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  for (const old of backups.slice(keep)) {
    try {
      rmSync(join(directory, old.f))
    } catch (error) {
      logger.warn('Could not remove old database backup', { file: old.f, error: String(error) })
    }
  }
}

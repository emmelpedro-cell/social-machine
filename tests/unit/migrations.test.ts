import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  MIGRATIONS,
  MigrationError,
  currentSchemaVersion,
  latestVersion,
  runMigrations,
  type Migration
} from '../../src/main/db/migrations'
import { openDatabase } from '../../src/main/db/open'
import { createNodeSqliteDriver, memoryLogger, tempDir } from '../helpers/node-sqlite-driver'

const tableNames = (db: ReturnType<typeof createNodeSqliteDriver>) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name
  )

describe('migrations', () => {
  it('creates the schema on an empty database', () => {
    const db = createNodeSqliteDriver()
    const result = runMigrations(db)
    expect(result.from).toBe(0)
    expect(result.to).toBe(latestVersion())
    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        'app_settings',
        'projects',
        'platforms',
        'accounts',
        'account_projects',
        'watch_folders',
        'contents',
        'content_versions',
        'publications',
        'metric_snapshots',
        'inbox_items',
        'queue_settings',
        'edit_presets',
        'tasks',
        'schema_migrations'
      ])
    )
    const platforms = db.prepare('SELECT id FROM platforms ORDER BY id').all() as { id: string }[]
    expect(platforms.map((p) => p.id)).toEqual(['instagram', 'tiktok', 'youtube'])
  })

  it('is idempotent', () => {
    const db = createNodeSqliteDriver()
    runMigrations(db)
    const second = runMigrations(db)
    expect(second.applied).toEqual([])
    expect(currentSchemaVersion(db)).toBe(latestVersion())
  })

  it('applies only new migrations to an existing database', () => {
    const db = createNodeSqliteDriver()
    runMigrations(db)
    const next: Migration = {
      version: latestVersion() + 1,
      name: 'add_test_table',
      sql: 'CREATE TABLE test_extra (id INTEGER PRIMARY KEY)'
    }
    const result = runMigrations(db, [...MIGRATIONS, next])
    expect(result.applied).toEqual([next.version])
    expect(tableNames(db)).toContain('test_extra')
  })

  it('rolls back a failing migration and keeps the previous version', () => {
    const db = createNodeSqliteDriver()
    runMigrations(db)
    const broken: Migration = {
      version: latestVersion() + 1,
      name: 'broken',
      sql: 'CREATE TABLE half_done (id INTEGER); INSERT INTO table_that_does_not_exist VALUES (1);'
    }
    expect(() => runMigrations(db, [...MIGRATIONS, broken])).toThrow(MigrationError)
    expect(currentSchemaVersion(db)).toBe(latestVersion())
    expect(tableNames(db)).not.toContain('half_done')
  })

  it('refuses to run when a shipped migration was edited', () => {
    const db = createNodeSqliteDriver()
    runMigrations(db)
    const edited = MIGRATIONS.map((m, i) => (i === 0 ? { ...m, sql: m.sql + '\n-- edited' } : m))
    expect(() => runMigrations(db, edited)).toThrow(/was modified after it was applied/)
  })

  it('refuses to open a database from a newer app version', () => {
    const db = createNodeSqliteDriver()
    const future: Migration = { version: latestVersion() + 5, name: 'future', sql: 'SELECT 1' }
    runMigrations(db, [...MIGRATIONS, future])
    expect(() => runMigrations(db, MIGRATIONS)).toThrow(/newer version of the app/)
  })

  it('rejects a migration list that is out of order', () => {
    const db = createNodeSqliteDriver()
    const bad: Migration[] = [
      { version: 2, name: 'b', sql: 'SELECT 1' },
      { version: 1, name: 'a', sql: 'SELECT 1' }
    ]
    expect(() => runMigrations(db, bad)).toThrow(/Migration list is invalid/)
  })

  it('enforces constraints at the database level', () => {
    const db = createNodeSqliteDriver()
    runMigrations(db)
    const insertProject = db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    expect(() => insertProject.run('x', '   ', 'now', 'now')).toThrow()
    insertProject.run('p1', 'MMA', 'now', 'now')
    // Project names are unique regardless of case.
    expect(() => insertProject.run('p2', 'mma', 'now', 'now')).toThrow()
    // Unknown workflow states are rejected.
    expect(() =>
      db
        .prepare(
          `INSERT INTO contents (id, source_path, path_key, file_name, file_size, status, workflow_status, imported_at, updated_at)
           VALUES ('c', 'a', 'a', 'a', 0, 'pending', 'published', 'now', 'now')`
        )
        .run()
    ).toThrow()
  })

  it('keeps contents when their project is deleted, and never stores tokens in accounts', () => {
    const db = createNodeSqliteDriver()
    runMigrations(db)
    db.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'Skate', 'now', 'now')`).run()
    db.prepare(
      `INSERT INTO contents (id, project_id, source_path, path_key, file_name, file_size, status, imported_at, updated_at)
       VALUES ('c1', 'p1', 'a.mp4', 'a.mp4', 'a.mp4', 1, 'ready', 'now', 'now')`
    ).run()
    db.prepare(`DELETE FROM projects WHERE id = 'p1'`).run()
    expect(db.prepare(`SELECT project_id FROM contents WHERE id = 'c1'`).get()).toEqual({ project_id: null })

    const accountColumns = (db.prepare('PRAGMA table_info(accounts)').all() as { name: string }[]).map((c) => c.name)
    expect(accountColumns).toContain('token_ref')
    expect(accountColumns.some((c) => /^(access_)?token$|secret|password/.test(c))).toBe(false)
  })

  it('prevents two publications with the same idempotency key', () => {
    const db = createNodeSqliteDriver()
    runMigrations(db)
    db.prepare(
      `INSERT INTO contents (id, source_path, path_key, file_name, file_size, status, imported_at, updated_at)
       VALUES ('c1', 'a.mp4', 'a.mp4', 'a.mp4', 1, 'ready', 'now', 'now')`
    ).run()
    db.prepare(
      `INSERT INTO accounts (id, platform_id, display_name, created_at, updated_at) VALUES ('a1', 'youtube', 'MMA', 'now', 'now')`
    ).run()
    const insert = db.prepare(
      `INSERT INTO publications (id, content_id, account_id, idempotency_key, created_at, updated_at)
       VALUES (?, 'c1', 'a1', 'c1:a1:1', 'now', 'now')`
    )
    insert.run('pub1')
    expect(() => insert.run('pub2')).toThrow()
  })
})

describe('openDatabase', () => {
  it('creates a new database file without making a backup', () => {
    const dir = tempDir()
    try {
      const opened = openDatabase({
        databasePath: join(dir.path, 'database.sqlite'),
        backupsDirectory: join(dir.path, 'backups'),
        createDriver: createNodeSqliteDriver,
        logger: memoryLogger()
      })
      expect(opened.schemaVersion).toBe(latestVersion())
      expect(opened.backupPath).toBeNull()
      opened.db.close()
    } finally {
      dir.cleanup()
    }
  })

  it('backs up an existing database before migrating it, keeping its data', () => {
    const dir = tempDir()
    const databasePath = join(dir.path, 'database.sqlite')
    const backupsDirectory = join(dir.path, 'backups')
    try {
      const first = openDatabase({ databasePath, backupsDirectory, createDriver: createNodeSqliteDriver, logger: memoryLogger() })
      first.db
        .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('project-1', 'MMA', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      first.db.close()

      const next: Migration = { version: latestVersion() + 1, name: 'next', sql: 'CREATE TABLE later (id INTEGER)' }
      const second = openDatabase({
        databasePath,
        backupsDirectory,
        createDriver: createNodeSqliteDriver,
        logger: memoryLogger(),
        migrations: [...MIGRATIONS, next]
      })
      expect(second.backupPath).not.toBeNull()
      expect(existsSync(second.backupPath!)).toBe(true)
      expect(readdirSync(backupsDirectory)).toHaveLength(1)
      second.db.close()

      // The backup is a complete, openable database at the old version.
      const backup = createNodeSqliteDriver(second.backupPath!)
      expect(currentSchemaVersion(backup)).toBe(latestVersion())
      expect(backup.prepare('SELECT name FROM projects').get()).toEqual({ name: 'MMA' })
      backup.close()
    } finally {
      dir.cleanup()
    }
  })
})

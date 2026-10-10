import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/main/db/migrations'
import type { SqlDriver } from '../../src/main/db/driver'
import { SettingsRepository } from '../../src/main/repositories/settings'
import { DEFAULT_SETTINGS } from '../../src/shared/schemas'
import { createNodeSqliteDriver, memoryLogger } from '../helpers/node-sqlite-driver'

describe('SettingsRepository', () => {
  let db: SqlDriver
  let logger: ReturnType<typeof memoryLogger>
  let repo: SettingsRepository

  beforeEach(() => {
    db = createNodeSqliteDriver()
    runMigrations(db)
    logger = memoryLogger()
    repo = new SettingsRepository(db, logger)
  })

  it('returns defaults when nothing is stored', () => {
    expect(repo.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('persists updates', () => {
    repo.update({ accentColor: '#4c9be8', exportDirectory: 'D:\\Exports' })
    const fresh = new SettingsRepository(db, logger)
    expect(fresh.get()).toEqual({ ...DEFAULT_SETTINGS, accentColor: '#4c9be8', exportDirectory: 'D:\\Exports' })
  })

  it('rejects invalid values on write', () => {
    expect(() => repo.update({ accentColor: 'red' })).toThrow()
    expect(() => repo.update({ watchScanIntervalSeconds: 1 })).toThrow()
    expect(repo.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('falls back to the default for a corrupt stored value and logs it', () => {
    db.prepare('INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(
      'accentColor',
      '"not-a-color"',
      'now'
    )
    db.prepare('INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(
      'minimizeToTray',
      '{broken json',
      'now'
    )
    expect(repo.get()).toEqual(DEFAULT_SETTINGS)
    expect(logger.entries.filter((e) => e.level === 'warn')).toHaveLength(2)
  })

  it('persists background behaviour settings', () => {
    repo.update({ minimizeToTray: false, launchAtLogin: true, watchScanIntervalSeconds: 300 })
    expect(new SettingsRepository(db, logger).get()).toMatchObject({
      minimizeToTray: false,
      launchAtLogin: true,
      watchScanIntervalSeconds: 300
    })
  })

  it('ignores keys written by a newer version', () => {
    db.prepare('INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(
      'someFutureSetting',
      'true',
      'now'
    )
    expect(repo.get()).toEqual(DEFAULT_SETTINGS)
  })
})

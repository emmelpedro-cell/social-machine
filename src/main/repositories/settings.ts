import type { SqlDriver } from '../db/driver'
import { transaction } from '../db/driver'
import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from '../../shared/schemas'
import type { Logger } from '../logger'

type Row = { key: string; value_json: string }

/**
 * Key/value settings stored in SQLite. Each key is validated on read; an
 * invalid or unreadable value falls back to its default and is logged,
 * so one bad value can never prevent the app from starting.
 */
export class SettingsRepository {
  constructor(
    private readonly db: SqlDriver,
    private readonly logger: Logger,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  get(): Settings {
    const rows = this.db.prepare('SELECT key, value_json FROM app_settings').all() as Row[]
    const result: Settings = { ...DEFAULT_SETTINGS }
    const shape = SettingsSchema.shape

    for (const row of rows) {
      if (!(row.key in shape)) continue // unknown keys from newer versions are ignored
      const key = row.key as keyof Settings
      let raw: unknown
      try {
        raw = JSON.parse(row.value_json)
      } catch {
        this.logger.warn('Ignoring unreadable setting', { key })
        continue
      }
      const parsed = shape[key].safeParse(raw)
      if (parsed.success) {
        ;(result as Record<keyof Settings, unknown>)[key] = parsed.data
      } else {
        this.logger.warn('Ignoring invalid setting, using default', { key, issues: parsed.error.issues })
      }
    }
    return result
  }

  update(patch: Partial<Settings>): Settings {
    const merged = SettingsSchema.parse({ ...this.get(), ...patch })
    transaction(this.db, () => {
      const upsert = this.db.prepare(
        `INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      for (const key of Object.keys(patch) as (keyof Settings)[]) {
        upsert.run(key, JSON.stringify(merged[key]), this.now())
      }
    })
    return this.get()
  }
}

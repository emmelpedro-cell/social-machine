import { randomUUID } from 'node:crypto'
import type { SqlDriver } from '../db/driver'
import { defaultQueueSettings, type QueueSettings, type Weekday } from '../../shared/publishing'

type Row = {
  account_id: string
  preferred_days_json: string
  preferred_times_json: string
  timezone: string
  enabled: number
}

function parse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

/** Posting preferences per account (planning slots). */
export class QueueSettingsRepository {
  constructor(
    private readonly db: SqlDriver,
    private readonly timezone: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    private readonly newId: () => string = randomUUID
  ) {}

  get(accountId: string): QueueSettings {
    const row = this.db
      .prepare('SELECT account_id, preferred_days_json, preferred_times_json, timezone, enabled FROM queue_settings WHERE account_id = ?')
      .get(accountId) as Row | undefined
    if (!row) return defaultQueueSettings(accountId, this.timezone())
    return {
      accountId,
      enabled: Number(row.enabled) === 1,
      days: parse<Weekday[]>(row.preferred_days_json, []),
      times: parse<string[]>(row.preferred_times_json, []),
      timezone: row.timezone
    }
  }

  all(accountIds: readonly string[]): QueueSettings[] {
    return accountIds.map((id) => this.get(id))
  }

  save(settings: QueueSettings): QueueSettings {
    const days = [...new Set(settings.days)].sort()
    const times = [...new Set(settings.times)].sort()
    this.db
      .prepare(
        `INSERT INTO queue_settings (id, account_id, preferred_days_json, preferred_times_json, posts_per_day, timezone, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET preferred_days_json = excluded.preferred_days_json,
           preferred_times_json = excluded.preferred_times_json, posts_per_day = excluded.posts_per_day,
           timezone = excluded.timezone, enabled = excluded.enabled`
      )
      .run(this.newId(), settings.accountId, JSON.stringify(days), JSON.stringify(times), times.length, settings.timezone, settings.enabled ? 1 : 0)
    return this.get(settings.accountId)
  }
}

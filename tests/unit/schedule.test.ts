import { describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/main/db/migrations'
import { AccountsRepository } from '../../src/main/repositories/accounts'
import { QueueSettingsRepository } from '../../src/main/repositories/queue-settings'
import { dayKey, fromLocalInput, nextFreeSlots, toLocalInput } from '../../src/shared/schedule'
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver'

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi)

describe('posting slots', () => {
  // 2026-10-12 is a Monday.
  const settings = { enabled: true, days: [1, 3, 5] as (0 | 1 | 2 | 3 | 4 | 5 | 6)[], times: ['19:00', '12:00'] }

  it('suggests the next preferred slots in local time, skipping past ones', () => {
    const slots = nextFreeSlots(settings, [], local(2026, 10, 12, 13, 0), 4)
    expect(slots.map(toLocalInput)).toEqual(['2026-10-12T19:00', '2026-10-14T12:00', '2026-10-14T19:00', '2026-10-16T12:00'])
  })

  it('skips slots already taken by the account (within the tolerance)', () => {
    const taken = [local(2026, 10, 12, 19, 10), local(2026, 10, 14, 12, 0).toISOString()]
    const slots = nextFreeSlots(settings, taken, local(2026, 10, 12, 8, 0), 3)
    expect(slots.map(toLocalInput)).toEqual(['2026-10-12T12:00', '2026-10-14T19:00', '2026-10-16T12:00'])
  })

  it('returns nothing when disabled or empty', () => {
    expect(nextFreeSlots({ ...settings, enabled: false }, [], new Date(), 2)).toEqual([])
    expect(nextFreeSlots({ ...settings, times: [] }, [], new Date(), 2)).toEqual([])
  })

  it('converts datetime-local values', () => {
    const d = local(2026, 3, 5, 9, 7)
    expect(toLocalInput(d)).toBe('2026-03-05T09:07')
    expect(fromLocalInput('2026-03-05T09:07')).toBe(d.toISOString())
    expect(fromLocalInput('')).toBeNull()
    expect(dayKey(d)).toBe('2026-03-05')
  })

  it('stores posting preferences per account, with defaults', () => {
    const db = createNodeSqliteDriver()
    runMigrations(db)
    const accounts = new AccountsRepository(db)
    const repo = new QueueSettingsRepository(db, () => 'America/Sao_Paulo')
    const a = accounts.addManual({ platformId: 'tiktok', displayName: '@x', projectIds: [] })
    expect(repo.get(a.id)).toEqual({ accountId: a.id, enabled: true, days: [0, 1, 2, 3, 4, 5, 6], times: ['12:00', '19:00'], timezone: 'America/Sao_Paulo' })
    repo.save({ accountId: a.id, enabled: false, days: [5, 1, 1], times: ['21:30', '08:00'], timezone: 'America/Sao_Paulo' })
    expect(repo.get(a.id)).toMatchObject({ enabled: false, days: [1, 5], times: ['08:00', '21:30'] })
    repo.save({ accountId: a.id, enabled: true, days: [0], times: ['10:00'], timezone: 'UTC' })
    expect(repo.all([a.id])).toEqual([{ accountId: a.id, enabled: true, days: [0], times: ['10:00'], timezone: 'UTC' }])
    db.close()
  })
})

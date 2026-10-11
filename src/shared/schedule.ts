import type { QueueSettings } from './publishing'

/**
 * Posting slots from an account's preferences, in the computer's local time.
 * A slot is free when no publication of the account is planned within
 * `toleranceMinutes` of it.
 */
export function nextFreeSlots(
  settings: Pick<QueueSettings, 'days' | 'times' | 'enabled'>,
  occupied: readonly (string | Date)[],
  after: Date,
  count = 1,
  options: { horizonDays?: number; toleranceMinutes?: number } = {}
): Date[] {
  if (!settings.enabled || settings.days.length === 0 || settings.times.length === 0) return []
  const tolerance = (options.toleranceMinutes ?? 30) * 60_000
  const taken = occupied.map((o) => new Date(o).getTime())
  const times = [...settings.times].sort()
  const result: Date[] = []
  const start = new Date(after.getFullYear(), after.getMonth(), after.getDate())
  for (let day = 0; day < (options.horizonDays ?? 60) && result.length < count; day++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day)
    if (!settings.days.includes(date.getDay() as never)) continue
    for (const t of times) {
      const [h, m] = t.split(':').map(Number) as [number, number]
      const slot = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m, 0, 0)
      if (slot.getTime() <= after.getTime()) continue
      if (taken.some((x) => Math.abs(x - slot.getTime()) < tolerance)) continue
      if (result.some((r) => r.getTime() === slot.getTime())) continue
      result.push(slot)
      if (result.length >= count) break
    }
  }
  return result
}

/** Value for <input type="datetime-local"> in local time. */
export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Parses a datetime-local value (local time) to an ISO string with offset, or null. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** Local calendar day key, e.g. "2026-10-11". */
export function dayKey(date: Date): string {
  return toLocalInput(date).slice(0, 10)
}

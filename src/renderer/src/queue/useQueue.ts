import { useCallback, useEffect, useRef, useState } from 'react'
import type { QueueItem } from '../../../shared/publishing'
import { api, unwrap } from '../api'

/**
 * Publications planned in [from, to] plus everything waiting for the user.
 * Reloads (debounced) on every publication event, so lists and calendars stay current.
 */
export function useQueue(from: Date, to: Date): { items: QueueItem[] | null; reload: () => Promise<void> } {
  const [items, setItems] = useState<QueueItem[] | null>(null)
  const fromIso = from.toISOString()
  const toIso = to.toISOString()
  const reload = useCallback(async () => {
    setItems(await unwrap(api.publications.queue(fromIso, toIso)))
  }, [fromIso, toIso])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const unsubscribe = api.publications.onEvent((event) => {
      if (event.type !== 'publication') return
      // Live progress updates in place; anything else reloads (status, time and grouping may change).
      setItems((current) => {
        if (!current) return current
        const index = current.findIndex((p) => p.id === event.publication.id)
        if (index === -1) return current
        const next = current.slice()
        next[index] = { ...current[index]!, ...event.publication }
        return next
      })
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void reload().catch(() => undefined), 250)
    })
    reload().catch(() => setItems([]))
    // Waiting items change with time (due, missed): refresh every minute.
    const interval = setInterval(() => void reload().catch(() => undefined), 60_000)
    return () => {
      unsubscribe()
      clearInterval(interval)
      if (timer.current) clearTimeout(timer.current)
    }
  }, [reload])

  return { items, reload }
}

export type QueueFilter = { project: string; account: string }

export function applyFilter(items: QueueItem[], filter: QueueFilter): QueueItem[] {
  return items.filter(
    (i) =>
      (filter.project === 'all' || (filter.project === 'none' ? i.projectId === null : i.projectId === filter.project)) &&
      (filter.account === 'all' || i.accountId === filter.account)
  )
}

/** Waiting for a decision: manual posts, failures, missed and paused schedules. */
export function needsAttention(i: QueueItem): boolean {
  return i.status === 'manual_pending' || i.status === 'failed' || i.status === 'draft' || (i.status === 'scheduled' && Boolean(i.fields.missed))
}

/** The time a publication sits at on a calendar. */
export function itemTime(i: QueueItem): string {
  return i.scheduledAt ?? i.publishedAt ?? i.createdAt
}

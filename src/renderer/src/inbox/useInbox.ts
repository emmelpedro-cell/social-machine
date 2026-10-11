import { useCallback, useEffect, useRef, useState } from 'react'
import type { InboxAccountStatus, InboxItem } from '../../../shared/inbox'
import { api, unwrap } from '../api'

/** Inbox items and per-account status, reloaded when a sync or an action changes them. */
export function useInbox(): { items: InboxItem[] | null; status: InboxAccountStatus[] | null; reload: () => Promise<void> } {
  const [items, setItems] = useState<InboxItem[] | null>(null)
  const [status, setStatus] = useState<InboxAccountStatus[] | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reload = useCallback(async () => {
    const [i, s] = await Promise.all([unwrap(api.inbox.list()), unwrap(api.inbox.status())])
    setItems(i)
    setStatus(s)
  }, [])
  useEffect(() => {
    const later = () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void reload().catch(() => undefined), 150)
    }
    const offInbox = api.inbox.onEvent(later)
    const offAccounts = api.publications.onEvent((e) => e.type === 'accounts' && later())
    reload().catch(() => {
      setItems([])
      setStatus([])
    })
    return () => {
      offInbox()
      offAccounts()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [reload])
  return { items, status, reload }
}

/** Unread count for the sidebar badge. */
export function useInboxUnread(): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    const load = () =>
      unwrap(api.inbox.status()).then(
        (s) => setCount(s.reduce((n, a) => n + a.unread, 0)),
        () => undefined
      )
    const off = api.inbox.onEvent(() => void load())
    void load()
    return off
  }, [])
  return count
}

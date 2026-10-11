import { useCallback, useEffect, useState } from 'react'
import type { Account, PlatformInfo, PublicationSummary } from '../../../shared/publishing'
import { api, unwrap } from '../api'

/** Accounts and platforms, refreshed when the main process says accounts changed. */
export function useAccounts(): { accounts: Account[] | null; platforms: PlatformInfo[] | null; reload: () => Promise<void> } {
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [platforms, setPlatforms] = useState<PlatformInfo[] | null>(null)
  const reload = useCallback(async () => {
    const [a, p] = await Promise.all([unwrap(api.accounts.list()), unwrap(api.platforms.list())])
    setAccounts(a)
    setPlatforms(p)
  }, [])
  useEffect(() => {
    const unsubscribe = api.publications.onEvent((event) => {
      if (event.type === 'accounts') void reload().catch(() => undefined)
    })
    reload().catch(() => {
      setAccounts([])
      setPlatforms([])
    })
    return unsubscribe
  }, [reload])
  return { accounts, platforms, reload }
}

/** Publications (of one content, or the most recent ones), kept current by push events. */
export function usePublications(contentId?: string, limit = 50): { publications: PublicationSummary[] | null; reload: () => Promise<void> } {
  const [publications, setPublications] = useState<PublicationSummary[] | null>(null)
  const reload = useCallback(async () => {
    setPublications(await unwrap(api.publications.list(contentId ? { contentId, limit } : { limit })))
  }, [contentId, limit])
  useEffect(() => {
    const unsubscribe = api.publications.onEvent((event) => {
      if (event.type !== 'publication') return
      if (contentId && event.publication.contentId !== contentId) return
      setPublications((current) => {
        if (!current) return current
        const index = current.findIndex((p) => p.id === event.publication.id)
        if (index === -1) {
          // A new publication: reload to get account and content names.
          void reload().catch(() => undefined)
          return current
        }
        const next = current.slice()
        next[index] = { ...current[index]!, ...event.publication }
        return next
      })
    })
    reload().catch(() => setPublications([]))
    return unsubscribe
  }, [contentId, reload])
  return { publications, reload }
}

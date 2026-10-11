import { useCallback, useEffect, useState } from 'react'
import type { ContentVersion } from '../../../shared/editor'
import { api, unwrap } from '../api'

/** Versions of one content, kept current by push events. */
export function useVersions(contentId: string | null): { versions: ContentVersion[] | null; reload: () => Promise<void> } {
  const [versions, setVersions] = useState<ContentVersion[] | null>(null)

  const reload = useCallback(async () => {
    if (!contentId) return
    setVersions(await unwrap(api.versions.list(contentId)))
  }, [contentId])

  useEffect(() => {
    setVersions(null)
    if (!contentId) return
    const unsubscribe = api.versions.onEvent((event) => {
      if (event.type === 'version' && event.version.contentId === contentId) {
        setVersions((current) => {
          if (!current) return current
          const index = current.findIndex((v) => v.id === event.version.id)
          if (index === -1) return [event.version, ...current]
          const next = current.slice()
          next[index] = event.version
          return next
        })
      } else if (event.type === 'version-removed' && event.contentId === contentId) {
        setVersions((current) => current?.filter((v) => v.id !== event.id) ?? current)
      }
    })
    reload().catch(() => setVersions([]))
    return unsubscribe
  }, [contentId, reload])

  return { versions, reload }
}

/** Number of versions per content, for library cards. */
export function useVersionCounts(): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    const refresh = () =>
      unwrap(api.versions.counts())
        .then(setCounts)
        .catch(() => undefined)
    const unsubscribe = api.versions.onEvent((event) => {
      if (event.type === 'version-removed' || (event.type === 'version' && event.version.progress === 0)) void refresh()
    })
    void refresh()
    return unsubscribe
  }, [])
  return counts
}

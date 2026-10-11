import { useCallback, useEffect, useRef, useState } from 'react'
import type { AnalyticsOverview, ContentAnalytics } from '../../../shared/analytics'
import { api, unwrap } from '../api'

/** Reloads when metrics are collected or entered, and when a publication is published. */
function useLive(reload: () => Promise<void>) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const later = () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void reload().catch(() => undefined), 250)
    }
    const offMetrics = api.analytics.onEvent(later)
    const offPublications = api.publications.onEvent((e) => {
      if (e.type === 'publication' && e.publication.status === 'published') later()
    })
    return () => {
      offMetrics()
      offPublications()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [reload])
}

export function useAnalyticsOverview(): { data: AnalyticsOverview | null; reload: () => Promise<void> } {
  const [data, setData] = useState<AnalyticsOverview | null>(null)
  const reload = useCallback(async () => setData(await unwrap(api.analytics.overview())), [])
  useEffect(() => {
    reload().catch(() => setData({ rows: [], accounts: [] }))
  }, [reload])
  useLive(reload)
  return { data, reload }
}

export function useContentAnalytics(contentId: string): { data: ContentAnalytics | null; reload: () => Promise<void> } {
  const [data, setData] = useState<ContentAnalytics | null>(null)
  const reload = useCallback(async () => setData(await unwrap(api.analytics.content(contentId))), [contentId])
  useEffect(() => {
    reload().catch(() => setData({ rows: [], history: {} }))
  }, [reload])
  useLive(reload)
  return { data, reload }
}

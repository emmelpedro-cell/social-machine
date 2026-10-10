import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImportQueueState, ContentItem, MediaEvent, MediaToolsStatus } from '../../../shared/media'
import { api, unwrap } from '../api'

export type MediaLibrary = {
  assets: ContentItem[] | null
  queue: ImportQueueState
  tools: MediaToolsStatus | null
  loadError: string | null
  recheckTools: () => Promise<MediaToolsStatus>
  reload: () => Promise<void>
}

const IDLE: ImportQueueState = { active: false, total: 0, completed: 0, failed: 0, current: [] }

/**
 * Library state for the whole app. Loads once, then stays current through
 * push events from the main process (no polling).
 */
export function useMediaLibrary(onDuplicate: (fileName: string, existing: string) => void): MediaLibrary {
  const [assets, setAssets] = useState<ContentItem[] | null>(null)
  const [queue, setQueue] = useState<ImportQueueState>(IDLE)
  const [tools, setTools] = useState<MediaToolsStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const duplicateRef = useRef(onDuplicate)
  duplicateRef.current = onDuplicate

  const reload = useCallback(async () => {
    const [list, state] = await Promise.all([unwrap(api.media.list()), unwrap(api.media.queueState())])
    setAssets(list)
    setQueue(state)
  }, [])

  useEffect(() => {
    // Subscribe first so no event between load and subscription is lost.
    const unsubscribe = api.media.onEvent((event: MediaEvent) => {
      switch (event.type) {
        case 'asset':
          setAssets((current) => {
            if (!current) return current
            const index = current.findIndex((a) => a.id === event.asset.id)
            if (index === -1) return [event.asset, ...current]
            const next = current.slice()
            next[index] = event.asset
            return next
          })
          break
        case 'removed':
          setAssets((current) => current?.filter((a) => a.id !== event.id) ?? current)
          break
        case 'queue':
          setQueue(event.state)
          break
        case 'duplicate':
          duplicateRef.current(event.fileName, event.existingFileName)
          break
      }
    })
    reload().catch((error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)))
    unwrap(api.media.toolsStatus())
      .then(setTools)
      .catch(() => setTools(null))
    return unsubscribe
  }, [reload])

  const recheckTools = useCallback(async () => {
    const status = await unwrap(api.media.recheckTools())
    setTools(status)
    return status
  }, [])

  return { assets, queue, tools, loadError, recheckTools, reload }
}

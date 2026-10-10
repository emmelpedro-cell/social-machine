import { useCallback, useEffect, useState } from 'react'
import type { WatchFolderStatus } from '../../../shared/watch'
import { api, unwrap } from '../api'

export type WatchFolders = {
  folders: WatchFolderStatus[] | null
  reload: () => Promise<void>
}

/** Watched folders, kept current by push events from the main process. */
export function useWatchFolders(): WatchFolders {
  const [folders, setFolders] = useState<WatchFolderStatus[] | null>(null)

  const reload = useCallback(async () => {
    setFolders(await unwrap(api.watch.list()))
  }, [])

  useEffect(() => {
    const unsubscribe = api.watch.onEvent((event) => {
      if (event.type === 'folders') setFolders(event.folders)
    })
    reload().catch(() => setFolders([]))
    return unsubscribe
  }, [reload])

  return { folders, reload }
}

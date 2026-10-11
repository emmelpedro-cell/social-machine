import { useMemo, useState } from 'react'
import { needsAttention, useQueue } from './useQueue'

const DAY = 86_400_000

/** How many publications wait for the user (sidebar badge). */
export function useAttentionCount(): number {
  const [range] = useState(() => ({ from: new Date(Date.now() - DAY), to: new Date(Date.now() + DAY) }))
  const { items } = useQueue(range.from, range.to)
  return useMemo(() => (items ?? []).filter(needsAttention).length, [items])
}

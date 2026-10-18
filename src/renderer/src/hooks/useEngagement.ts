import { useEffect, useState } from 'react'
import type { EngagementRow } from '../../../shared/engagements'

/** The active engagement run (§6.4), if any. Reads on mount and follows the
 *  `engagement:changed` push so start/stop reflect live. */
export function useEngagement(): {
  current: EngagementRow | null
  start: (goal: string) => Promise<EngagementRow | null>
  stop: (id?: string) => Promise<void>
  refresh: () => Promise<void>
} {
  const [current, setCurrent] = useState<EngagementRow | null>(null)

  useEffect(() => {
    let live = true
    void window.reconix.engagement
      .current()
      .then((initial) => {
        if (live) setCurrent(initial)
      })
      .catch(() => undefined)
    const unsubscribe = window.reconix.engagement.onChanged(setCurrent)
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  const start = async (goal: string): Promise<EngagementRow | null> => {
    const row = await window.reconix.engagement.start(goal)
    if (row) setCurrent(row)
    return row
  }
  const stop = async (id?: string): Promise<void> => {
    await window.reconix.engagement.stop(id)
    setCurrent(null)
  }
  const refresh = async (): Promise<void> => {
    const row = await window.reconix.engagement.current()
    setCurrent(row)
  }

  return { current, start, stop, refresh }
}

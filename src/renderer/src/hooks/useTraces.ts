import { useEffect, useState } from 'react'
import type { TraceSummary } from '../../../shared/traces'

/** Agent-captured traces (screenshot / reqresp / trace), newest first. Reads the
 *  current set on mount and follows the `traces:changed` push, same shape as
 *  useFindings. Contents are fetched lazily per ref via window.reconix.traces.get. */
export function useTraces(): TraceSummary[] {
  const [traces, setTraces] = useState<TraceSummary[]>([])

  useEffect(() => {
    let live = true
    void window.reconix.traces
      .list()
      .then((initial) => {
        if (live) setTraces(initial)
      })
      .catch(() => undefined)
    const unsubscribe = window.reconix.traces.onChanged(setTraces)
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  return traces
}

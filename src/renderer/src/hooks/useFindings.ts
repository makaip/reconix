import { useEffect, useState } from 'react'
import type { Finding } from '../../../shared/findings'

/** Agent-recorded findings (record_finding), newest last. Reads the current set
 *  on mount and follows the `findings:changed` push, same shape as useSitemap. */
export function useFindings(): Finding[] {
  const [findings, setFindings] = useState<Finding[]>([])

  useEffect(() => {
    let live = true
    void window.reconix.findings
      .list()
      .then((initial) => {
        if (live) setFindings(initial)
      })
      .catch(() => undefined)
    const unsubscribe = window.reconix.findings.onChanged(setFindings)
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  return findings
}

import { useEffect, useState } from 'react'
import type { Finding } from '../../../shared/findings'

/** Agent-recorded findings (record_finding), newest last. Reads the current set
 *  on mount and follows the `findings:changed` push, same shape as useSitemap. */
export function useFindings(): Finding[] {
  const [findings, setFindings] = useState<Finding[]>([])

  useEffect(() => {
    let live = true
    const reload = (): void => {
      void window.reconix.findings
        .list()
        .then((initial) => {
          if (live) setFindings(initial)
        })
        .catch(() => undefined)
    }
    reload()
    const unsubscribeFindings = window.reconix.findings.onChanged(setFindings)
    // Re-fetch when the active engagement changes so findings from a previous
    // run/site don't bleed into the current one.
    const unsubscribeEngagement = window.reconix.engagement.onChanged(() => reload())
    return () => {
      live = false
      unsubscribeFindings()
      unsubscribeEngagement()
    }
  }, [])

  return findings
}

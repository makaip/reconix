import { useCallback, useEffect, useState } from 'react'
import type { Finding, FindingTriagePatch } from '../../../shared/findings'

export type UseFindings = {
  findings: Finding[]
  /** Triage write (status/notes/cvss). Resolves true when the finding existed.
   *  The authoritative update arrives through `findings:changed`; callers should
   *  treat this as fire-and-forget and let the broadcast re-render the list. */
  updateFinding: (id: string, patch: FindingTriagePatch) => Promise<boolean>
}

/** Agent-recorded findings (record_finding), newest last. Reads the current set
 *  on mount and follows the `findings:changed` push, same shape as useSitemap. */
export function useFindings(): UseFindings {
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

  // No optimistic write: the main process broadcasts the recomputed list, so a
  // local patch here would race with (and momentarily contradict) that push.
  const updateFinding = useCallback(
    (id: string, patch: FindingTriagePatch): Promise<boolean> =>
      window.reconix.findings.update(id, patch).catch(() => false),
    []
  )

  return { findings, updateFinding }
}

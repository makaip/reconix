import { useEffect, useState } from 'react'
import type { ScopeStatus } from '../../../shared/contracts'

const NO_SCOPE: ScopeStatus = { hosts: [], summary: 'none' }

/** Read-only view of the engagement's authorized scope, for the URL-bar badge
 *  and the status-bar summary. Static for now (scope.json is read at boot), so
 *  a single mount-time fetch is enough. */
export function useScope(): ScopeStatus {
  const [scope, setScope] = useState<ScopeStatus>(NO_SCOPE)

  useEffect(() => {
    let live = true
    void window.reconix.scope
      .get()
      .then((initial) => {
        if (live && initial) setScope(initial)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  return scope
}

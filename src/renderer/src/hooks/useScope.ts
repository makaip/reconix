import { useEffect, useState } from 'react'
import type { ScopeStatus } from '../../../shared/contracts'

const NO_SCOPE: ScopeStatus = { hosts: [], summary: 'none' }

/** Read-only view of the engagement's authorized scope, for the URL-bar badge
 *  and the status-bar summary. Seeded with a mount-time fetch, then kept live by
 *  main's `scope:changed` push so engagement start/stop updates without a reload. */
export function useScope(): ScopeStatus {
  const [scope, setScope] = useState<ScopeStatus>(NO_SCOPE)

  useEffect(() => {
    let live = true
    const apply = (next: ScopeStatus | null): void => {
      if (live && next) setScope(next)
    }

    void window.reconix.scope
      .get()
      .then(apply)
      .catch(() => undefined)

    const unsubscribe = window.reconix.scope.onChanged(apply)

    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  return scope
}

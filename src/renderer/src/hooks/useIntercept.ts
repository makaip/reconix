import { useEffect, useState } from 'react'
import type { InterceptRule, SaveInterceptRuleInput } from '../../../shared/tabs'

export type InterceptApi = {
  rules: InterceptRule[]
  save: (input: SaveInterceptRuleInput) => Promise<InterceptRule | null>
  toggle: (id: string, enabled: boolean) => Promise<InterceptRule | null>
  remove: (id: string) => Promise<boolean>
}

/** Live view of match/replace rules, kept in sync via intercept:changed. */
export function useIntercept(): InterceptApi {
  const [rules, setRules] = useState<InterceptRule[]>([])

  useEffect(() => {
    let live = true
    void window.reconix.intercept.list().then((initial) => {
      if (live) setRules(initial)
    })
    const unsubscribe = window.reconix.intercept.onChanged(setRules)
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  return {
    rules,
    save: window.reconix.intercept.save,
    toggle: window.reconix.intercept.toggle,
    remove: window.reconix.intercept.delete
  }
}

import { useEffect, useState } from 'react'
import type { TabsState } from '../../../shared/tabs'

const EMPTY: TabsState = { tabs: [], activeId: null, canGoBack: false, canGoForward: false }

/** Tab list and navigation state, owned by the main process. */
export function useTabs(): TabsState {
  const [state, setState] = useState<TabsState>(EMPTY)

  useEffect(() => {
    let live = true
    void window.reconix.tabs.getState().then((initial) => {
      if (live && initial) setState(initial)
    })
    const unsubscribe = window.reconix.tabs.onState(setState)
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  return state
}

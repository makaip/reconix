import { useEffect, useState } from 'react'
import type { ResourceInfo } from '../../../shared/devtools'

export type ResourcesApi = {
  resources: ResourceInfo[]
  loaded: boolean
}

/** The inspected page's scripts/stylesheets/documents, refetched on load and on navigation. */
export function useResources(activeTabId: number | null): ResourcesApi {
  const [resources, setResources] = useState<ResourceInfo[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let stale = false

    const load = (): void => {
      void window.reconix.devtools.getResources().then((list) => {
        if (!stale) {
          setResources(list ?? [])
          setLoaded(true)
        }
      })
    }

    setResources([])
    setLoaded(false)
    if (activeTabId !== null) load()

    const unsubscribe = window.reconix.devtools.onEvent((event) => {
      if (event.method === 'DOM.documentUpdated' && activeTabId !== null) load()
    })
    return () => {
      stale = true
      unsubscribe()
    }
  }, [activeTabId])

  return { resources, loaded }
}

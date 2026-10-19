import { useCallback, useEffect, useState } from 'react'
import type { CookieInfo, StorageArea, StorageEntry, StorageState } from '../../../shared/devtools'

export type ApplicationApi = {
  cookies: CookieInfo[]
  localStorage: StorageEntry[]
  sessionStorage: StorageEntry[]
  loaded: boolean
  refresh: () => void
  deleteCookie: (name: string) => Promise<void>
  setStorageItem: (area: StorageArea, key: string, value: string) => Promise<void>
  deleteStorageItem: (area: StorageArea, key: string) => Promise<void>
  clearStorage: (area: StorageArea) => Promise<void>
  exportStorageState: () => Promise<StorageState | null>
  importStorageState: (state: StorageState) => Promise<boolean>
}

/** Cookies + localStorage/sessionStorage for the inspected page. Refetched on navigation. */
export function useApplication(activeTabId: number | null): ApplicationApi {
  const [cookies, setCookies] = useState<CookieInfo[]>([])
  const [localStorageEntries, setLocalStorageEntries] = useState<StorageEntry[]>([])
  const [sessionStorageEntries, setSessionStorageEntries] = useState<StorageEntry[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const [nextCookies, nextLocal, nextSession] = await Promise.all([
      window.reconix.devtools.getCookies(),
      window.reconix.devtools.getStorage('local'),
      window.reconix.devtools.getStorage('session')
    ])
    setCookies(nextCookies ?? [])
    setLocalStorageEntries(nextLocal ?? [])
    setSessionStorageEntries(nextSession ?? [])
    setLoaded(true)
  }, [])

  useEffect(() => {
    setCookies([])
    setLocalStorageEntries([])
    setSessionStorageEntries([])
    setLoaded(false)
    if (activeTabId === null) return

    void load()
    return window.reconix.devtools.onEvent((event) => {
      if (event.method === 'DOM.documentUpdated') void load()
    })
  }, [activeTabId, load])

  return {
    cookies,
    localStorage: localStorageEntries,
    sessionStorage: sessionStorageEntries,
    loaded,
    refresh: () => void load(),
    deleteCookie: async (name) => {
      await window.reconix.devtools.deleteCookie(name)
      await load()
    },
    setStorageItem: async (area, key, value) => {
      await window.reconix.devtools.setStorageItem({ area, key, value })
      await load()
    },
    deleteStorageItem: async (area, key) => {
      await window.reconix.devtools.deleteStorageItem({ area, key })
      await load()
    },
    clearStorage: async (area) => {
      await window.reconix.devtools.clearStorage(area)
      await load()
    },
    exportStorageState: () => window.reconix.devtools.exportStorageState(),
    importStorageState: async (state) => {
      const ok = await window.reconix.devtools.importStorageState(state)
      if (ok) await load()
      return Boolean(ok)
    }
  }
}

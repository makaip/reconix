import { useCallback, useEffect, useState } from 'react'

// Renderer-only settings, persisted in localStorage. No main-process wiring yet —
// this is the boilerplate for a real settings store, so keep the shape small and
// the defaults sensible. Add fields here and they flow through the modal.
export type Settings = {
  openSidebarOnLaunch: boolean
  openCopilotOnLaunch: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  openSidebarOnLaunch: true,
  openCopilotOnLaunch: true
}

const STORAGE_KEY = 'reconix.settings'

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    // merge so a stored blob missing newer keys still gets their defaults
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export type UseSettings = {
  settings: Settings
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void
}

export function useSettings(): UseSettings {
  const [settings, setSettings] = useState<Settings>(load)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      // storage unavailable (private mode etc.) — settings just won't persist
    }
  }, [settings])

  const set = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }, [])

  return { settings, set }
}

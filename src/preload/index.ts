import { contextBridge, ipcRenderer } from 'electron'

// typed surface is exposed to renderer but renderer never accesses ipcRenderer directly
export type Bounds = { x: number; y: number; width: number; height: number }
export type NavigateResult = { ok: true } | { ok: false; error: string }

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),
  target: {
    setBounds: (bounds: Bounds): Promise<void> => ipcRenderer.invoke('target:set-bounds', bounds),
    navigate: (url: string): Promise<NavigateResult> => ipcRenderer.invoke('target:navigate', url)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('reconix', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore, contextIsolation disabled fallback
  window.reconix = api
}

export type ReconixApi = typeof api

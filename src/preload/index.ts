import { contextBridge, ipcRenderer } from 'electron'

// typed surface is exposed to renderer but renderer never accesses ipcRenderer directly
const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('ping')
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

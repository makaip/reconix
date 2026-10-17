import { contextBridge, ipcRenderer } from 'electron'
import type { CdpNode, DevToolsEvent, StyleRule } from '../shared/devtools'

// typed surface is exposed to renderer but renderer never accesses ipcRenderer directly
export type Bounds = { x: number; y: number; width: number; height: number }
export type NavigateResult = { ok: true } | { ok: false; error: string }

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),
  target: {
    setBounds: (bounds: Bounds): Promise<void> => ipcRenderer.invoke('target:set-bounds', bounds),
    navigate: (url: string): Promise<NavigateResult> => ipcRenderer.invoke('target:navigate', url)
  },
  devtools: {
    getDocument: (): Promise<CdpNode | null> => ipcRenderer.invoke('devtools:get-document'),
    requestChildren: (nodeId: number): Promise<boolean | null> =>
      ipcRenderer.invoke('devtools:request-children', nodeId),
    getStyles: (nodeId: number): Promise<StyleRule[] | null> =>
      ipcRenderer.invoke('devtools:get-styles', nodeId),
    highlight: (nodeId: number | null): Promise<boolean | null> =>
      ipcRenderer.invoke('devtools:highlight', nodeId),
    setInspectMode: (enabled: boolean): Promise<boolean | null> =>
      ipcRenderer.invoke('devtools:set-inspect-mode', enabled),
    // subscribes to devtools DOM events
    // aso returns an unsubscribe function to stop listening to events
    onEvent: (callback: (event: DevToolsEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: DevToolsEvent): void =>
        callback(payload)
      ipcRenderer.on('devtools:event', listener)
      return () => ipcRenderer.removeListener('devtools:event', listener)
    }
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

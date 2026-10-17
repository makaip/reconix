import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentSessionState,
  AgentTask,
  ApprovalDecision,
  ApprovalRequest,
  Finding,
  StartAgentParams,
  ToolDescriptor
} from '../shared/agent'
import type {
  CdpNode,
  ConsoleEntry,
  CookieInfo,
  DevToolsEvent,
  NodeContext,
  ResourceContent,
  ResourceInfo,
  ResourceRef,
  StorageArea,
  StorageEntry,
  StyleRule
} from '../shared/devtools'
import type { CapturedRequest, NavigateResult, NetworkStats, TabsState } from '../shared/tabs'

// typed surface is exposed to renderer but renderer never accesses ipcRenderer directly
export type Bounds = { x: number; y: number; width: number; height: number }

// subscribes to a main-process event channel and returns an unsubscribe function
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),
  platform: process.platform,
  target: {
    setBounds: (bounds: Bounds): Promise<void> => ipcRenderer.invoke('target:set-bounds', bounds),
    // navigates the active tab
    navigate: (url: string): Promise<NavigateResult> => ipcRenderer.invoke('tabs:navigate', url),
    back: (): Promise<void> => ipcRenderer.invoke('tabs:back'),
    forward: (): Promise<void> => ipcRenderer.invoke('tabs:forward'),
    reload: (): Promise<void> => ipcRenderer.invoke('tabs:reload')
  },
  tabs: {
    getState: (): Promise<TabsState> => ipcRenderer.invoke('tabs:get-state'),
    create: (url?: string): Promise<number> => ipcRenderer.invoke('tabs:create', url),
    close: (id: number): Promise<void> => ipcRenderer.invoke('tabs:close', id),
    activate: (id: number): Promise<void> => ipcRenderer.invoke('tabs:activate', id),
    onState: (callback: (state: TabsState) => void): (() => void) => subscribe('tabs:state', callback)
  },
  network: {
    getStats: (): Promise<NetworkStats> => ipcRenderer.invoke('network:get-stats'),
    list: (tabId?: number): Promise<CapturedRequest[]> => ipcRenderer.invoke('network:list', tabId),
    onStats: (callback: (stats: NetworkStats) => void): (() => void) =>
      subscribe('network:stats', callback),
    // full capture list (all tabs, most recent 200), pushed whenever any request changes
    onRequests: (callback: (requests: CapturedRequest[]) => void): (() => void) =>
      subscribe('network:requests', callback)
  },
  devtools: {
    getDocument: (): Promise<CdpNode | null> => ipcRenderer.invoke('devtools:get-document'),
    requestChildren: (nodeId: number): Promise<boolean | null> =>
      ipcRenderer.invoke('devtools:request-children', nodeId),
    getStyles: (nodeId: number): Promise<StyleRule[] | null> =>
      ipcRenderer.invoke('devtools:get-styles', nodeId),
    getNodeContext: (nodeId: number): Promise<NodeContext | null> =>
      ipcRenderer.invoke('devtools:get-node-context', nodeId),
    highlight: (nodeId: number | null): Promise<boolean | null> =>
      ipcRenderer.invoke('devtools:highlight', nodeId),
    setInspectMode: (enabled: boolean): Promise<boolean | null> =>
      ipcRenderer.invoke('devtools:set-inspect-mode', enabled),
    // Console: runs `expression` in the target page and returns the formatted result/error
    evaluate: (expression: string): Promise<ConsoleEntry | null> =>
      ipcRenderer.invoke('devtools:console-evaluate', expression),
    // Sources
    getResources: (): Promise<ResourceInfo[] | null> => ipcRenderer.invoke('devtools:get-resources'),
    getResourceContent: (ref: ResourceRef): Promise<ResourceContent | null> =>
      ipcRenderer.invoke('devtools:get-resource-content', ref),
    // Application: cookies + storage
    getCookies: (): Promise<CookieInfo[] | null> => ipcRenderer.invoke('devtools:get-cookies'),
    deleteCookie: (name: string): Promise<boolean | null> => ipcRenderer.invoke('devtools:delete-cookie', name),
    getStorage: (area: StorageArea): Promise<StorageEntry[] | null> =>
      ipcRenderer.invoke('devtools:get-storage', area),
    setStorageItem: (payload: { area: StorageArea; key: string; value: string }): Promise<boolean | null> =>
      ipcRenderer.invoke('devtools:set-storage-item', payload),
    deleteStorageItem: (payload: { area: StorageArea; key: string }): Promise<boolean | null> =>
      ipcRenderer.invoke('devtools:delete-storage-item', payload),
    clearStorage: (area: StorageArea): Promise<boolean | null> =>
      ipcRenderer.invoke('devtools:clear-storage', area),
    // subscribes to devtools DOM events
    // aso returns an unsubscribe function to stop listening to events
    onEvent: (callback: (event: DevToolsEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: DevToolsEvent): void =>
        callback(payload)
      ipcRenderer.on('devtools:event', listener)
      return () => ipcRenderer.removeListener('devtools:event', listener)
    }
  },
  agent: {
    start: (params: StartAgentParams): Promise<AgentSessionState> =>
      ipcRenderer.invoke('agent:start', params),
    pause: (): Promise<void> => ipcRenderer.invoke('agent:pause'),
    resume: (): Promise<void> => ipcRenderer.invoke('agent:resume'),
    getState: (): Promise<AgentSessionState> => ipcRenderer.invoke('agent:get-state'),
    listTools: (): Promise<ToolDescriptor[]> => ipcRenderer.invoke('tool:list'),
    respondToApproval: (decision: ApprovalDecision): Promise<void> =>
      ipcRenderer.invoke('approval:respond', decision),
    onState: (callback: (state: AgentSessionState) => void): (() => void) =>
      subscribe('agent:state', callback),
    onPlanUpdate: (callback: (tasks: AgentTask[]) => void): (() => void) =>
      subscribe('plan:update', callback),
    onApprovalRequest: (callback: (request: ApprovalRequest) => void): (() => void) =>
      subscribe('approval:request', callback),
    onFinding: (callback: (finding: Finding) => void): (() => void) =>
      subscribe('finding:new', callback)
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

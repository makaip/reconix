import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentEvent,
  AgentSessionState,
  AgentTask,
  ApprovalDecision,
  ApprovalRequest,
  Finding,
  SendMessageParams,
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
  StorageState,
  StyleRule
} from '../shared/devtools'
import type {
  CapturedBody,
  CapturedRequest,
  NavigateResult,
  NetworkStats,
  InterceptRule,
  ReplayRequestInput,
  ReplayResult,
  SavedRequest,
  SaveInterceptRuleInput,
  SaveRequestInput,
  TabsState,
  WsConnection
} from '../shared/tabs'
import type { DiffResponsesOutput } from '../shared/tools'
// Aliased: shared/agent.ts already exports a (differently-shaped) AgentEvent/
// ApprovalDecision, imported above for the `agent` namespace. TODO: these are
// two parallel event/approval shapes for what's conceptually the same
// concept — worth reconciling once `agent.*` vs `copilot.*` below gets sorted out.
import type {
  AgentEvent as CopilotAgentEvent,
  ApprovalDecision as CopilotApprovalDecision,
  EngineStatus,
  ProxyStatus,
  ScopeStatus,
  ServerStatus,
  ToolAccess,
  UsageSnapshot
} from '../shared/contracts'
import type { CrawlStartInput, CrawlState } from '../shared/crawler'
import type { EngagementRow } from '../shared/engagements'
import type { TraceDetail, TraceSummary } from '../shared/traces'

// typed surface is exposed to renderer but renderer never accesses ipcRenderer directly
export type Bounds = { x: number; y: number; width: number; height: number }

// Result of an update check requested from the UI: `ok` + the version found
// available (absent = already current), or `error` when the check failed.
export type UpdateCheckResult = {
  ok: boolean
  version?: string
  error?: string
}

// Model/provider configuration edited from the Settings panel. This is the
// renderer-side mirror of main's modelSettings module (kept structural so the
// preload bundle never pulls in node-only main code): one target per agent role
// plus user-added OpenAI-compatible backends.
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high'

/** One selectable model: OpenCode addresses these as `<provider>/<model>`. */
export interface ModelTarget {
  provider: string
  model: string
  /** Optional per-target endpoint override (custom OpenAI-compatible servers). */
  baseUrl?: string | null
  /** Optional per-target key override. Never logged. */
  apiKey?: string | null
}

/** A user-added OpenAI-compatible backend, mirrored into opencode.json. */
export interface CustomBackend {
  id: string
  baseUrl: string
  apiKey: string
  model: string
}

export type ModelRole = 'orchestrator' | 'domAnalyzer'

export type ModelSettings = {
  orchestrator: ModelTarget
  domAnalyzer: ModelTarget
  reasoning: ReasoningEffort
  customBackends: CustomBackend[]
}

// Connection probe target: a role name (probe that role's saved target) or an
// ad-hoc endpoint the user is still editing in the form.
export type SettingsTestTarget =
  | ModelRole
  | {
      provider?: string
      baseUrl?: string | null
      apiKey?: string | null
      model?: string
    }

export type SettingsSetResult = {
  ok: boolean
  error?: string
}

export type SettingsTestResult = {
  ok: boolean
  error?: string
  /** Model ids reported by the endpoint when the probe succeeded. */
  models?: string[]
}

// Reads the app version from main synchronously at preload time so the Settings
// panel renders it without a placeholder flash. Falls back to '' if the channel
// isn't up yet (the UI degrades to "unknown version").
function readAppVersion(): string {
  try {
    const version = ipcRenderer.sendSync('app:get-version')
    return typeof version === 'string' ? version : ''
  } catch {
    return ''
  }
}

// subscribes to a main-process event channel and returns an unsubscribe function
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Fixed, named surface only. No method takes a code string that executes in the
// UI/renderer: devtools.evaluate forwards an expression to the TARGET page over CDP
// in main, it is not an eval channel into this window. index.d.ts mirrors this via
// `typeof api`, so the two stay in sync automatically.
const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),
  platform: process.platform,
  menu: {
    // Fired when the user picks File ▸ Preferences from the native app menu.
    onOpenSettings: (callback: () => void): (() => void) => subscribe('menu:open-settings', callback)
  },
  app: {
    // App version from main (app.getVersion()), read at preload time.
    version: readAppVersion(),
    // Ask main to check the update feed now. Resolves { ok, version? } or
    // { ok: false, error } — never throws, so the UI can show the failure.
    checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('app:check-for-updates'),
    // Quit and install the already-downloaded update (restarts the app).
    quitAndInstall: (): Promise<boolean> => ipcRenderer.invoke('app:quit-and-install'),
    // Fires once a background update finishes downloading; returns an unsubscribe.
    onUpdateDownloaded: (callback: (payload: { version: string }) => void): (() => void) =>
      subscribe('app:update-downloaded', callback)
  },
  settings: {
    // Persisted model/provider settings (readback on mount).
    get: (): Promise<ModelSettings> => ipcRenderer.invoke('settings:get'),
    // Persist the full settings object. Never throws; reports failure in-band.
    set: (settings: ModelSettings): Promise<SettingsSetResult> =>
      ipcRenderer.invoke('settings:set', settings),
    // Probe a provider endpoint without saving it. Returns the model list on
    // success so the UI can offer a picker.
    testConnection: (target: SettingsTestTarget): Promise<SettingsTestResult> =>
      ipcRenderer.invoke('settings:test-connection', target)
  },
  target: {
    setBounds: (bounds: Bounds): Promise<void> => ipcRenderer.invoke('target:set-bounds', bounds),
    // Hides every native target view while a renderer overlay (settings modal) is up,
    // so the HTML modal isn't painted behind the page.
    setOverlay: (active: boolean): Promise<void> => ipcRenderer.invoke('target:set-overlay', active),
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
    // moves a tab so it ends up at `toIndex` in the tab strip
    move: (id: number, toIndex: number): Promise<void> => ipcRenderer.invoke('tabs:move', id, toIndex),
    onState: (callback: (state: TabsState) => void): (() => void) => subscribe('tabs:state', callback)
  },
  network: {
    getStats: (): Promise<NetworkStats> => ipcRenderer.invoke('network:get-stats'),
    list: (tabId?: number): Promise<CapturedRequest[]> => ipcRenderer.invoke('network:list', tabId),
    // Full req/resp record (incl. bodies) for one CDP request on the inspected target.
    getBody: (requestId: string): Promise<CapturedBody | null> =>
      ipcRenderer.invoke('network:get-body', requestId),
    // Repeater: resend an arbitrary request. Scope- and rate-gated in main.
    replay: (input: ReplayRequestInput): Promise<ReplayResult> =>
      ipcRenderer.invoke('replay:send', input),
    onStats: (callback: (stats: NetworkStats) => void): (() => void) =>
      subscribe('network:stats', callback),
    // full capture list (all tabs, most recent 200), pushed whenever any request changes
    onRequests: (callback: (requests: CapturedRequest[]) => void): (() => void) =>
      subscribe('network:requests', callback)
  },
  websocket: {
    // WebSocket connections + frames captured over CDP on the inspected target.
    list: (): Promise<WsConnection[]> => ipcRenderer.invoke('websocket:list'),
    onChanged: (callback: (conns: WsConnection[]) => void): (() => void) =>
      subscribe('websocket:changed', callback)
  },
  findings: {
    // Agent-recorded findings (record_finding), newest last. `list` is the
    // mount-time readback; the push fires whenever one is recorded.
    list: (): Promise<Finding[]> => ipcRenderer.invoke('findings:list'),
    onChanged: (callback: (findings: Finding[]) => void): (() => void) =>
      subscribe('findings:changed', callback)
  },
  traces: {
    // Agent-captured evidence blobs (screenshot / reqresp / trace). `list` is the
    // metadata readback; `get` inflates one (binary as base64). The push fires
    // whenever the agent stores a new trace.
    list: (): Promise<TraceSummary[]> => ipcRenderer.invoke('traces:list'),
    get: (ref: string): Promise<TraceDetail | null> => ipcRenderer.invoke('traces:get', ref),
    onChanged: (callback: (traces: TraceSummary[]) => void): (() => void) =>
      subscribe('traces:changed', callback)
  },
  scope: {
    // Read-only view of the engagement's authorized scope, for the URL-bar
    // badge and status-bar summary. Static per run (scope.json is read at boot).
    get: (): Promise<ScopeStatus> => ipcRenderer.invoke('scope:get')
  },
  proxy: {
    // Configured egress proxy address (RECONIX_PROXY_ADDR), or null. The app
    // doesn't manage the container proxy, so there's no live health to report.
    getStatus: (): Promise<ProxyStatus> => ipcRenderer.invoke('proxy:get-status')
  },
  engagement: {
    // Authorized engagement id from the loaded scope.json, or null.
    get: (): Promise<string | null> => ipcRenderer.invoke('engagement:get'),
    // Start a new engagement run over the loaded scope. Returns the row, or null.
    start: (goal: string, scope?: unknown, policy?: unknown): Promise<EngagementRow | null> =>
      ipcRenderer.invoke('engagement:start', goal, scope, policy),
    stop: (id?: string): Promise<void> => ipcRenderer.invoke('engagement:stop', id),
    current: (): Promise<EngagementRow | null> => ipcRenderer.invoke('engagement:current'),
    list: (): Promise<EngagementRow[]> => ipcRenderer.invoke('engagement:list'),
    onChanged: (callback: (row: EngagementRow | null) => void): (() => void) =>
      subscribe('engagement:changed', callback)
  },
  crawler: {
    // Deterministic scope-aware spider. Drives the gated replayer; no new egress.
    start: (input: CrawlStartInput): Promise<CrawlState> => ipcRenderer.invoke('crawl:start', input),
    stop: (): Promise<CrawlState> => ipcRenderer.invoke('crawl:stop'),
    getState: (): Promise<CrawlState> => ipcRenderer.invoke('crawl:get-state'),
    onState: (callback: (state: CrawlState) => void): (() => void) =>
      subscribe('crawl:state', callback)
  },
  repeater: {
    list: (): Promise<SavedRequest[]> => ipcRenderer.invoke('repeater:list'),
    // create (no id) or update (with id) a saved request
    save: (input: SaveRequestInput): Promise<SavedRequest | null> =>
      ipcRenderer.invoke('repeater:save', input),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('repeater:delete', id),
    // resend a saved request through the gated replayer; appends to its response history
    send: (id: string): Promise<SavedRequest | null> => ipcRenderer.invoke('repeater:send', id),
    // diff two of a saved request's responses (defaults to the two most recent)
    diff: (payload: { id: string; aIndex?: number; bIndex?: number }): Promise<DiffResponsesOutput | null> =>
      ipcRenderer.invoke('repeater:diff', payload),
    // pushed whenever the saved set changes (save/delete/send)
    onChanged: (callback: (saved: SavedRequest[]) => void): (() => void) =>
      subscribe('repeater:changed', callback)
  },
  intercept: {
    list: (): Promise<InterceptRule[]> => ipcRenderer.invoke('intercept:list'),
    save: (input: SaveInterceptRuleInput): Promise<InterceptRule | null> =>
      ipcRenderer.invoke('intercept:save', input),
    toggle: (id: string, enabled: boolean): Promise<InterceptRule | null> =>
      ipcRenderer.invoke('intercept:toggle', id, enabled),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('intercept:delete', id),
    onChanged: (callback: (rules: InterceptRule[]) => void): (() => void) =>
      subscribe('intercept:changed', callback)
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
    // Playwright-style storageState snapshot of the active tab (cookies + localStorage)
    exportStorageState: (): Promise<StorageState | null> =>
      ipcRenderer.invoke('devtools:export-storage-state'),
    importStorageState: (state: StorageState): Promise<boolean | null> =>
      ipcRenderer.invoke('devtools:import-storage-state', state),
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
    // §6.1 sendMessage {text}: a user message into the agent session.
    sendMessage: (params: SendMessageParams): Promise<void> =>
      ipcRenderer.invoke('sendMessage', params),
    // §6.1 respondApproval {approvalId, decision, editedParams?}. No code string crosses
    // the bridge — editedParams is a plain text key/value map only.
    respondApproval: (decision: ApprovalDecision): Promise<void> =>
      ipcRenderer.invoke('respondApproval', decision),
    // Legacy alias kept for backward-compat with earlier consumers.
    respondToApproval: (decision: ApprovalDecision): Promise<void> =>
      ipcRenderer.invoke('approval:respond', decision),
    // §6.1 agent:event: the one transcript stream (user / reasoning / tool-call /
    // tool-result / inline approval). Returns an unsubscribe function.
    onEvent: (callback: (event: AgentEvent) => void): (() => void) =>
      subscribe('agent:event', callback),
    onState: (callback: (state: AgentSessionState) => void): (() => void) =>
      subscribe('agent:state', callback),
    onPlanUpdate: (callback: (tasks: AgentTask[]) => void): (() => void) =>
      subscribe('plan:update', callback),
    onApprovalRequest: (callback: (request: ApprovalRequest) => void): (() => void) =>
      subscribe('approval:request', callback),
    onFinding: (callback: (finding: Finding) => void): (() => void) =>
      subscribe('finding:new', callback)
  },
  copilot: {
    // Resolves once OpenCode has durably admitted the message; the reply
    // itself streams in separately through onEvent.
    send: (text: string): Promise<{ messageId: string }> => ipcRenderer.invoke('copilot:send', text),
    newChat: (): Promise<string> => ipcRenderer.invoke('copilot:new-chat'),
    setTargetTab: (tabId: number): Promise<boolean> => ipcRenderer.invoke('copilot:set-target-tab', tabId),
    getTargetTab: (): Promise<number | null> => ipcRenderer.invoke('copilot:get-target-tab'),
    getToolAccess: (): Promise<ToolAccess[]> => ipcRenderer.invoke('copilot:get-tool-access'),
    getRestrictions: (): Promise<string> => ipcRenderer.invoke('copilot:get-restrictions'),
    setRestrictions: (text: string): Promise<string> => ipcRenderer.invoke('copilot:set-restrictions', text),
    setEnabledTools: (names: string[]): Promise<ToolAccess[]> =>
      ipcRenderer.invoke('copilot:set-enabled-tools', names),
    respondApproval: (approvalId: string, decision: CopilotApprovalDecision): Promise<void> =>
      ipcRenderer.invoke('copilot:respond-approval', approvalId, decision),
    respondQuestion: (questionId: string, answer: unknown): Promise<void> =>
      ipcRenderer.invoke('copilot:respond-question', questionId, answer),
    onQuestion: (callback: (q: { questionId: string; header: string; question: string; options?: string[]; multiple?: boolean }) => void): (() => void) =>
      subscribe('copilot:question', callback),
    interrupt: (): Promise<void> => ipcRenderer.invoke('copilot:interrupt'),
    onEvent: (callback: (event: CopilotAgentEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: CopilotAgentEvent): void => callback(payload)
      ipcRenderer.on('copilot:event', listener)
      return () => ipcRenderer.removeListener('copilot:event', listener)
    },
    onStatus: (callback: (status: ServerStatus) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ServerStatus): void => callback(payload)
      ipcRenderer.on('copilot:status', listener)
      return () => ipcRenderer.removeListener('copilot:status', listener)
    },
    // Current engine boot status, read on mount. The push below can fire
    // before the renderer subscribes (main creates the bridge before the
    // window loads), so this readback is what actually keeps the loading
    // banner honest — don't rely on the event alone.
    getEngineStatus: (): Promise<EngineStatus> => ipcRenderer.invoke('copilot:get-engine-status'),
    // Engine boot status (opencode serve + the MCP tool server), not to be
    // confused with onStatus's OpenCode session ServerStatus above — this
    // fires once at launch (starting -> ready|error), before any session exists.
    onEngineStatus: (callback: (status: EngineStatus) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: EngineStatus): void => callback(payload)
      ipcRenderer.on('copilot:engine-status', listener)
      return () => ipcRenderer.removeListener('copilot:engine-status', listener)
    },
    // Cost/latency meter readback + live pushes (counts and timing only).
    getUsage: (): Promise<UsageSnapshot> => ipcRenderer.invoke('copilot:usage-snapshot'),
    onUsage: (callback: (usage: UsageSnapshot) => void): (() => void) =>
      subscribe('copilot:usage', callback)
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

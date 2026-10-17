// types are shared by the main process (CDP inspector), preload and renderer (devtools UI)

// DOM node as returned by the Chrome DevTools Protocol DOM domain
export type CdpNode = {
  nodeId: number
  parentId?: number
  nodeType: number
  nodeName: string
  localName?: string
  nodeValue: string
  childNodeCount?: number
  children?: CdpNode[]
  // note that this is a flat [name, value, name, value, ...] list
  attributes?: string[]
}

export type StyleProperty = { name: string; value: string; important: boolean }

export type StyleRule = {
  origin: 'inline' | 'author' | 'user-agent'
  selector: string
  // e.g. app.css:212; absent for inline and user-agent rules
  source?: string
  properties: StyleProperty[]
}

export type NodeContext = {
  outerHTML: string
  truncated: boolean
  computedStyle: Record<string, string>
}

// --- Console -----------------------------------------------------------------

export type ConsoleLevel = 'log' | 'info' | 'warning' | 'error' | 'debug'

export type ConsoleEntrySource =
  | 'console' // console.log/warn/error/etc. called by page script
  | 'exception' // an uncaught exception in the page
  | 'log' // CDP Log domain (security/deprecation/intervention messages, CSP violations, …)
  | 'eval-command' // echo of what the user typed into the REPL (renderer-only, never sent by main)
  | 'eval-result' // the REPL's result for that command

export type ConsoleEntry = {
  id: string
  level: ConsoleLevel
  text: string
  source: ConsoleEntrySource
  timestamp: number
}

// --- Sources -------------------------------------------------------------------

/** One resource (document, script, stylesheet, image, …) as Page.getResourceTree reports it. */
export type ResourceInfo = {
  frameId: string
  url: string
  type: string // CDP Page.ResourceType, e.g. "Document" | "Script" | "Stylesheet" | "Image" | ...
  mimeType: string
}

export type ResourceRef = { frameId: string; url: string }

export type ResourceContent = {
  content: string
  truncated: boolean
  /** Content is binary (image, font, …) and wasn't decoded; `content` is empty. */
  binary: boolean
}

// --- Application (cookies + storage) -------------------------------------------

export type CookieInfo = {
  name: string
  value: string
  domain: string
  path: string
  expires: number // unix seconds, or -1 for a session cookie
  httpOnly: boolean
  secure: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

export type StorageArea = 'local' | 'session'

export type StorageEntry = { key: string; value: string }

export type DevToolsEvent =
  | { method: 'DOM.documentUpdated'; params: Record<string, never> }
  | { method: 'DOM.setChildNodes'; params: { parentId: number; nodes: CdpNode[] } }
  | {
      method: 'DOM.childNodeInserted'
      params: { parentNodeId: number; previousNodeId: number; node: CdpNode }
    }
  | { method: 'DOM.childNodeRemoved'; params: { parentNodeId: number; nodeId: number } }
  | { method: 'DOM.childNodeCountUpdated'; params: { nodeId: number; childNodeCount: number } }
  | { method: 'DOM.attributeModified'; params: { nodeId: number; name: string; value: string } }
  | { method: 'DOM.attributeRemoved'; params: { nodeId: number; name: string } }
  | { method: 'DOM.characterDataModified'; params: { nodeId: number; characterData: string } }
  | { method: 'Reconix.nodeInspected'; params: { nodeId: number } } // sent after user picks element with the page inspector
  | { method: 'Reconix.consoleEntry'; params: { entry: ConsoleEntry } }
  | { method: 'Reconix.consoleCleared'; params: Record<string, never> } // page script called console.clear()

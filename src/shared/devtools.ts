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

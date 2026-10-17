import { BrowserWindow, WebContents, ipcMain } from 'electron'
import type {
  CdpNode,
  ConsoleEntry,
  ConsoleLevel,
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

const FORWARDED_EVENTS = new Set([
  'DOM.documentUpdated',
  'DOM.setChildNodes',
  'DOM.childNodeInserted',
  'DOM.childNodeRemoved',
  'DOM.childNodeCountUpdated',
  'DOM.attributeModified',
  'DOM.attributeRemoved',
  'DOM.characterDataModified'
])

const HIGHLIGHT_CONFIG = {
  showInfo: true,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 }
}

type CssProperty = {
  name: string
  value: string
  important?: boolean
  implicit?: boolean
  disabled?: boolean
  parsedOk?: boolean
}
type CssStyle = {
  cssProperties: CssProperty[]
  styleSheetId?: string
  range?: { startLine: number }
}
type CssRule = {
  origin: string
  selectorList: { text: string; selectors: { text: string }[] }
  style: CssStyle
}
type SheetInfo = { url: string; inline: boolean }

// --- Console / Runtime --------------------------------------------------------

type RemoteObject = {
  type: string
  subtype?: string
  className?: string
  value?: unknown
  description?: string
  unserializableValue?: string
}
type ExceptionDetails = { text: string; lineNumber: number; exception?: RemoteObject }
type ConsoleApiCalledParams = { type: string; args: RemoteObject[]; timestamp: number }
type ExceptionThrownParams = { timestamp: number; exceptionDetails: ExceptionDetails }
type LogEntry = { source: string; level: string; text: string; timestamp: number; url?: string }
type LogEntryAddedParams = { entry: LogEntry }
type ExecutionContext = { id: number; auxData?: { isDefault?: boolean } }
type ExecutionContextCreatedParams = { context: ExecutionContext }
type ExecutionContextDestroyedParams = { executionContextId: number }

const CONSOLE_LEVELS: Record<string, ConsoleLevel> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
  debug: 'debug'
}
const LOG_LEVELS: Record<string, ConsoleLevel> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
  verbose: 'debug'
}

/** Best-effort text form of a CDP RemoteObject — not a full inspector, just enough to read in a log line. */
function formatRemoteObject(obj: RemoteObject | undefined): string {
  if (!obj) return 'undefined'
  if (obj.unserializableValue !== undefined) return obj.unserializableValue
  switch (obj.type) {
    case 'undefined':
      return 'undefined'
    case 'string':
      return typeof obj.value === 'string' ? obj.value : String(obj.value)
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(obj.value)
    case 'symbol':
    case 'function':
      return obj.description ?? obj.type
    case 'object':
      if (obj.subtype === 'null') return 'null'
      return obj.description ?? obj.className ?? 'Object'
    default:
      return obj.description ?? String(obj.value ?? obj.type)
  }
}

// --- Sources -------------------------------------------------------------------

type PageResource = { url: string; type: string; mimeType: string }
type PageFrame = { id: string; url: string }
type PageFrameResourceTree = {
  frame: PageFrame
  resources: PageResource[]
  childFrames?: PageFrameResourceTree[]
}

function flattenResourceTree(tree: PageFrameResourceTree): ResourceInfo[] {
  const out: ResourceInfo[] = [
    { frameId: tree.frame.id, url: tree.frame.url, type: 'Document', mimeType: 'text/html' }
  ]
  for (const resource of tree.resources) {
    out.push({ frameId: tree.frame.id, url: resource.url, type: resource.type, mimeType: resource.mimeType })
  }
  for (const child of tree.childFrames ?? []) out.push(...flattenResourceTree(child))
  return out
}

// --- Application (cookies + storage) -------------------------------------------

type CdpCookie = {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

const storageExpression = (area: StorageArea): string =>
  area === 'local' ? 'window.localStorage' : 'window.sessionStorage'

const MAX_OUTER_HTML = 50_000
const MAX_RESOURCE_CONTENT = 300_000

const isNodeId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0
const isResourceRef = (value: unknown): value is ResourceRef => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return isNonEmptyString(v.frameId) && typeof v.url === 'string'
}
const isStorageArea = (value: unknown): value is StorageArea => value === 'local' || value === 'session'
const isStorageItemRef = (value: unknown): value is { area: StorageArea; key: string } => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return isStorageArea(v.area) && typeof v.key === 'string'
}
const isStorageSetPayload = (value: unknown): value is { area: StorageArea; key: string; value: string } =>
  isStorageItemRef(value) && typeof (value as Record<string, unknown>).value === 'string'
const isCookieName = (value: unknown): value is string => typeof value === 'string' && value.length > 0

function toProperties(style: CssStyle): StyleRule['properties'] {
  // note that declared properties carry implicit: false
  // also, rules without source info will fall back to everything that isn't implicit

  const declared = style.cssProperties.filter((p) => p.implicit === false)
  const source = declared.length ? declared : style.cssProperties.filter((p) => !p.implicit)
  return source
    .filter((p) => !p.disabled && p.parsedOk !== false)
    .map((p) => ({ name: p.name, value: p.value, important: Boolean(p.important) }))
}

function sourceLabel(sheet: SheetInfo | undefined, line: number | undefined): string | undefined {
  if (!sheet) return undefined
  let base = '<style>'
  if (!sheet.inline && sheet.url) {
    try {
      const url = new URL(sheet.url)
      base = url.pathname.split('/').filter(Boolean).pop() ?? url.host
    } catch {
      base = sheet.url
    }
  }
  return line === undefined ? base : `${base}:${line + 1}`
}

// attach chrome devtools protocol to target page and expose IPC surface for custom devtools UI.
// also generic CDP access isnt handed to render
export type Inspector = {
  // points the inspector at another page (or none), and the renderer reloads its tree
  setTarget: (target: WebContents | null) => void
}

export function attachInspector(win: BrowserWindow): Inspector {
  let current: WebContents | null = null
  let ready: Promise<boolean> = Promise.resolve(false)
  let stopListening: (() => void) | null = null
  const sheets = new Map<string, SheetInfo>()
  // Console entry ids and the REPL's execution context — reset on every target switch,
  // and the context id also tracks Runtime.executionContext{Created,Destroyed,sCleared}
  // so it stays valid across in-tab navigations (setTarget isn't called for those).
  let entryCounter = 0
  let contextId: number | null = null
  const newEntryId = (): string => `c${++entryCounter}`

  const send = <T>(method: string, params?: object): Promise<T> => {
    if (!current || current.isDestroyed()) return Promise.reject(new Error('No inspected page'))
    return current.debugger.sendCommand(method, params) as Promise<T>
  }

  const emit = (event: DevToolsEvent): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('devtools:event', event)
    }
  }

  async function resolveInspected(backendNodeId: number): Promise<void> {
    try {
      const { nodeIds } = await send<{ nodeIds: number[] }>('DOM.pushNodesByBackendIdsToFrontend', {
        backendNodeIds: [backendNodeId]
      })
      if (isNodeId(nodeIds[0])) emit({ method: 'Reconix.nodeInspected', params: { nodeId: nodeIds[0] } })
      // CDP rejects setInspectMode without a highlightConfig, even when turning it off
      await send('Overlay.setInspectMode', { mode: 'none', highlightConfig: HIGHLIGHT_CONFIG })
    } catch (error) {
      console.error('Could not resolve inspected node:', error)
    }
  }

  function setTarget(target: WebContents | null): void {
    stopListening?.()
    stopListening = null
    if (current && !current.isDestroyed() && current.debugger.isAttached()) {
      try {
        current.debugger.detach()
      } catch {
        // already detached
      }
    }
    current = target
    sheets.clear()
    entryCounter = 0
    contextId = null

    if (!target) {
      ready = Promise.resolve(false)
      emit({ method: 'DOM.documentUpdated', params: {} })
      return
    }

    const dbg = target.debugger
    const onMessage = (_event: unknown, method: string, params: Record<string, unknown>): void => {
      if (method === 'CSS.styleSheetAdded') {
        const header = params.header as { styleSheetId: string; sourceURL: string; isInline: boolean }
        sheets.set(header.styleSheetId, { url: header.sourceURL, inline: header.isInline })
      } else if (method === 'Overlay.inspectNodeRequested') {
        void resolveInspected(params.backendNodeId as number)
      } else if (method === 'Runtime.consoleAPICalled') {
        const p = params as unknown as ConsoleApiCalledParams
        if (p.type === 'clear') {
          emit({ method: 'Reconix.consoleCleared', params: {} })
          return
        }
        const entry: ConsoleEntry = {
          id: newEntryId(),
          level: CONSOLE_LEVELS[p.type] ?? 'log',
          text: p.args.map(formatRemoteObject).join(' '),
          source: 'console',
          timestamp: p.timestamp
        }
        emit({ method: 'Reconix.consoleEntry', params: { entry } })
      } else if (method === 'Runtime.exceptionThrown') {
        const { exceptionDetails, timestamp } = params as unknown as ExceptionThrownParams
        const entry: ConsoleEntry = {
          id: newEntryId(),
          level: 'error',
          text: exceptionDetails.exception
            ? formatRemoteObject(exceptionDetails.exception)
            : exceptionDetails.text,
          source: 'exception',
          timestamp
        }
        emit({ method: 'Reconix.consoleEntry', params: { entry } })
      } else if (method === 'Log.entryAdded') {
        const { entry: logEntry } = params as unknown as LogEntryAddedParams
        const entry: ConsoleEntry = {
          id: newEntryId(),
          level: LOG_LEVELS[logEntry.level] ?? 'log',
          text: logEntry.url ? `${logEntry.text} (${logEntry.url})` : logEntry.text,
          source: 'log',
          timestamp: logEntry.timestamp
        }
        emit({ method: 'Reconix.consoleEntry', params: { entry } })
      } else if (method === 'Runtime.executionContextCreated') {
        const { context } = params as unknown as ExecutionContextCreatedParams
        if (contextId === null || context.auxData?.isDefault) contextId = context.id
      } else if (method === 'Runtime.executionContextDestroyed') {
        const { executionContextId } = params as unknown as ExecutionContextDestroyedParams
        if (contextId === executionContextId) contextId = null
      } else if (method === 'Runtime.executionContextsCleared') {
        contextId = null
      } else if (FORWARDED_EVENTS.has(method)) {
        emit({ method, params } as DevToolsEvent)
      }
    }
    dbg.on('message', onMessage)
    stopListening = () => dbg.removeListener('message', onMessage)

    const attached = (async () => {
      dbg.attach('1.3')
      await dbg.sendCommand('DOM.enable')
      await dbg.sendCommand('CSS.enable')
      await dbg.sendCommand('Overlay.enable')
      await dbg.sendCommand('Runtime.enable')
      await dbg.sendCommand('Log.enable')
      await dbg.sendCommand('Page.enable')
      await dbg.sendCommand('Network.enable')
      return true
    })().catch((error) => {
      console.error('Inspector failed to attach:', error)
      return false
    })
    ready = attached
    void attached.then(() => {
      if (current === target) emit({ method: 'DOM.documentUpdated', params: {} })
    })
  }

  const handle = (channel: string, fn: (...args: unknown[]) => Promise<unknown>): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.sender !== win.webContents || !(await ready) || !current) return null
      try {
        return await fn(...args)
      } catch {
        // stlate node ids and mid-navigation races are expected, so im js putting an empty catch lol
        return null
      }
    })
  }

  handle('devtools:get-document', async () => {
    const { root } = await send<{ root: CdpNode }>('DOM.getDocument', { depth: 3 })
    return root
  })

  handle('devtools:request-children', async (nodeId) => {
    if (!isNodeId(nodeId)) return null
    await send('DOM.requestChildNodes', { nodeId, depth: 1 })
    return true
  })

  handle('devtools:get-styles', async (nodeId): Promise<StyleRule[] | null> => {
    if (!isNodeId(nodeId)) return null
    const [matched, inline] = await Promise.all([
      send<{ matchedCSSRules?: { rule: CssRule; matchingSelectors: number[] }[] }>('CSS.getMatchedStylesForNode', { nodeId }),
      send<{ inlineStyle?: CssStyle }>('CSS.getInlineStylesForNode', { nodeId })
    ])

    const rules: StyleRule[] = [
      {
        origin: 'inline',
        selector: 'element.style',
        properties: inline.inlineStyle ? toProperties(inline.inlineStyle) : []
      }
    ]
    // CDP lists lowest priority first, and DevTools shows highest priority first
    for (const { rule, matchingSelectors } of [...(matched.matchedCSSRules ?? [])].reverse()) {
      const userAgent = rule.origin === 'user-agent'
      // a rule like `a, b, c { }` only applies through the selectors that matched this node
      const matching = matchingSelectors
        .map((index) => rule.selectorList.selectors[index]?.text)
        .filter(Boolean)
        .join(', ')
      rules.push({
        origin: userAgent ? 'user-agent' : 'author',
        selector: matching || rule.selectorList.text,
        source: userAgent
          ? undefined
          : sourceLabel(
              rule.style.styleSheetId ? sheets.get(rule.style.styleSheetId) : undefined,
              rule.style.range?.startLine
            ),
        properties: toProperties(rule.style)
      })
    }
    return rules
  })

  handle('devtools:get-node-context', async (nodeId): Promise<NodeContext | null> => {
    if (!isNodeId(nodeId)) return null
    const [html, computed] = await Promise.all([
      send<{ outerHTML: string }>('DOM.getOuterHTML', { nodeId }),
      send<{ computedStyle: { name: string; value: string }[] }>('CSS.getComputedStyleForNode', {
        nodeId
      })
    ])
    return {
      outerHTML: html.outerHTML.slice(0, MAX_OUTER_HTML),
      truncated: html.outerHTML.length > MAX_OUTER_HTML,
      computedStyle: Object.fromEntries(computed.computedStyle.map((p) => [p.name, p.value]))
    }
  })

  handle('devtools:highlight', async (nodeId) => {
    if (nodeId === null) await send('Overlay.hideHighlight')
    else if (isNodeId(nodeId)) {
      await send('Overlay.highlightNode', { nodeId, highlightConfig: HIGHLIGHT_CONFIG })
    }
    return true
  })

  handle('devtools:set-inspect-mode', async (enabled) => {
    await send('Overlay.setInspectMode', {
      mode: enabled === true ? 'searchForNode' : 'none',
      highlightConfig: HIGHLIGHT_CONFIG
    })
    return true
  })

  // --- Console -------------------------------------------------------------

  handle('devtools:console-evaluate', async (expression): Promise<ConsoleEntry | null> => {
    if (typeof expression !== 'string' || !expression.trim()) return null
    const timestamp = Date.now()
    if (contextId === null) {
      return {
        id: newEntryId(),
        level: 'error',
        text: 'No execution context available for this page yet.',
        source: 'eval-result',
        timestamp
      }
    }
    try {
      const { result, exceptionDetails } = await send<{
        result: RemoteObject
        exceptionDetails?: ExceptionDetails
      }>('Runtime.evaluate', {
        expression,
        contextId,
        returnByValue: false,
        generatePreview: true,
        awaitPromise: true,
        userGesture: true
      })
      if (exceptionDetails) {
        return {
          id: newEntryId(),
          level: 'error',
          text: exceptionDetails.exception
            ? formatRemoteObject(exceptionDetails.exception)
            : exceptionDetails.text,
          source: 'eval-result',
          timestamp
        }
      }
      return { id: newEntryId(), level: 'log', text: formatRemoteObject(result), source: 'eval-result', timestamp }
    } catch (error) {
      return {
        id: newEntryId(),
        level: 'error',
        text: error instanceof Error ? error.message : String(error),
        source: 'eval-result',
        timestamp
      }
    }
  })

  // --- Sources ---------------------------------------------------------------

  handle('devtools:get-resources', async (): Promise<ResourceInfo[]> => {
    const { frameTree } = await send<{ frameTree: PageFrameResourceTree }>('Page.getResourceTree')
    return flattenResourceTree(frameTree)
  })

  handle('devtools:get-resource-content', async (ref): Promise<ResourceContent | null> => {
    if (!isResourceRef(ref)) return null
    const { content, base64Encoded } = await send<{ content: string; base64Encoded: boolean }>(
      'Page.getResourceContent',
      { frameId: ref.frameId, url: ref.url }
    )
    if (base64Encoded) return { content: '', truncated: false, binary: true }
    return {
      content: content.slice(0, MAX_RESOURCE_CONTENT),
      truncated: content.length > MAX_RESOURCE_CONTENT,
      binary: false
    }
  })

  // --- Application: cookies + storage -----------------------------------------

  handle('devtools:get-cookies', async (): Promise<CookieInfo[]> => {
    // Every tab shares TARGET_PARTITION's session, so an unscoped query would leak
    // other tabs' cookies into this page's panel — always scope to the current URL.
    const url = current?.getURL()
    if (!url) return []
    const { cookies } = await send<{ cookies: CdpCookie[] }>('Network.getAllCookies', { urls: [url] })
    return cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite
    }))
  })

  handle('devtools:delete-cookie', async (name) => {
    if (!isCookieName(name)) return null
    // Scoped to the current page's URL for the same reason get-cookies is.
    const url = current?.getURL()
    if (!url) return null
    await send('Network.deleteCookies', { name, url })
    return true
  })

  handle('devtools:get-storage', async (area): Promise<StorageEntry[] | null> => {
    if (!isStorageArea(area)) return null
    if (contextId === null) return []
    const { result } = await send<{ result: RemoteObject }>('Runtime.evaluate', {
      expression: `Object.entries(${storageExpression(area)})`,
      contextId,
      returnByValue: true
    })
    const entries = Array.isArray(result.value) ? (result.value as [string, string][]) : []
    return entries.map(([key, value]) => ({ key, value: String(value) }))
  })

  handle('devtools:set-storage-item', async (payload) => {
    if (!isStorageSetPayload(payload)) return null
    if (contextId === null) return null
    const { area, key, value } = payload
    // JSON.stringify both sides so the key/value are safely embedded as string literals
    await send('Runtime.evaluate', {
      expression: `${storageExpression(area)}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
      contextId
    })
    return true
  })

  handle('devtools:delete-storage-item', async (ref) => {
    if (!isStorageItemRef(ref)) return null
    if (contextId === null) return null
    await send('Runtime.evaluate', {
      expression: `${storageExpression(ref.area)}.removeItem(${JSON.stringify(ref.key)})`,
      contextId
    })
    return true
  })

  handle('devtools:clear-storage', async (area) => {
    if (!isStorageArea(area)) return null
    if (contextId === null) return null
    await send('Runtime.evaluate', { expression: `${storageExpression(area)}.clear()`, contextId })
    return true
  })

  win.on('closed', () => {
    for (const channel of [
      'devtools:get-document',
      'devtools:request-children',
      'devtools:get-styles',
      'devtools:get-node-context',
      'devtools:highlight',
      'devtools:set-inspect-mode',
      'devtools:console-evaluate',
      'devtools:get-resources',
      'devtools:get-resource-content',
      'devtools:get-cookies',
      'devtools:delete-cookie',
      'devtools:get-storage',
      'devtools:set-storage-item',
      'devtools:delete-storage-item',
      'devtools:clear-storage'
    ]) {
      ipcMain.removeHandler(channel)
    }
    setTarget(null)
  })

  return { setTarget }
}

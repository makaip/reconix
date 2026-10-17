import { BrowserWindow, WebContents, ipcMain } from 'electron'
import type { CdpNode, DevToolsEvent, NodeContext, StyleRule } from '../shared/devtools'

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
type CssRule = { origin: string; selectorList: { text: string }; style: CssStyle }
type SheetInfo = { url: string; inline: boolean }

const MAX_OUTER_HTML = 50_000

const isNodeId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

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
export function attachInspector(win: BrowserWindow, target: WebContents): void {
  const dbg = target.debugger
  const sheets = new Map<string, SheetInfo>()

  const send = <T>(method: string, params?: object): Promise<T> =>
    dbg.sendCommand(method, params) as Promise<T>

  const emit = (event: DevToolsEvent): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('devtools:event', event)
    }
  }

  const ready = (async () => {
    dbg.attach('1.3')
    await send('DOM.enable')
    await send('CSS.enable')
    await send('Overlay.enable')
    return true
  })().catch((error) => {
    console.error('Inspector failed to attach:', error)
    return false
  })

  async function resolveInspected(backendNodeId: number): Promise<void> {
    try {
      const { nodeIds } = await send<{ nodeIds: number[] }>('DOM.pushNodesByBackendIdsToFrontend', {
        backendNodeIds: [backendNodeId]
      })
      await send('Overlay.setInspectMode', { mode: 'none' })
      if (isNodeId(nodeIds[0])) emit({ method: 'Reconix.nodeInspected', params: { nodeId: nodeIds[0] } })
    } catch (error) {
      console.error('Could not resolve inspected node:', error)
    }
  }

  dbg.on('message', (_event, method, params: Record<string, unknown>) => {
    if (method === 'CSS.styleSheetAdded') {
      const header = params.header as { styleSheetId: string; sourceURL: string; isInline: boolean }
      sheets.set(header.styleSheetId, { url: header.sourceURL, inline: header.isInline })
    } else if (method === 'Overlay.inspectNodeRequested') {
      void resolveInspected(params.backendNodeId as number)
    } else if (FORWARDED_EVENTS.has(method)) {
      emit({ method, params } as DevToolsEvent)
    }
  })

  const handle = (channel: string, fn: (...args: unknown[]) => Promise<unknown>): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.sender !== win.webContents || !(await ready)) return null
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
      send<{ matchedCSSRules?: { rule: CssRule }[] }>('CSS.getMatchedStylesForNode', { nodeId }),
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
    for (const { rule } of [...(matched.matchedCSSRules ?? [])].reverse()) {
      const userAgent = rule.origin === 'user-agent'
      rules.push({
        origin: userAgent ? 'user-agent' : 'author',
        selector: rule.selectorList.text,
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

  win.on('closed', () => {
    for (const channel of [
      'devtools:get-document',
      'devtools:request-children',
      'devtools:get-styles',
      'devtools:get-node-context',
      'devtools:highlight',
      'devtools:set-inspect-mode'
    ]) {
      ipcMain.removeHandler(channel)
    }
    if (dbg.isAttached()) dbg.detach()
  })
}

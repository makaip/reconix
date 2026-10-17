import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { CdpNode, DevToolsEvent } from '../../../shared/devtools'

export const NODE_TYPE = { element: 1, text: 3, comment: 8, document: 9, doctype: 10 } as const

export type TreeNode = {
  id: number
  parentId: number | null
  type: number
  name: string
  value: string
  attrs: [string, string][]
  childCount: number          // number of non whitespace children (known even when they havent loaded yet)
  children: number[] | null   // child ids, or null when they havent been requested yet
}

export type TreeState = {
  nodes: Map<number, TreeNode>
  rootId: number | null
  expanded: Set<number>
  selectedId: number | null
}

export type TreeRowKind =
  | 'open'
  | 'collapsed'
  | 'inline'
  | 'leaf'
  | 'close'
  | 'text'
  | 'comment'
  | 'doctype'

export type TreeRow = { key: string; id: number; depth: number; kind: TreeRowKind }

type Action =
  | { type: 'reset'; root: CdpNode | null }
  | { type: 'event'; event: DevToolsEvent }
  | { type: 'toggle'; id: number }
  | { type: 'select'; id: number | null }

const INITIAL: TreeState = { nodes: new Map(), rootId: null, expanded: new Set(), selectedId: null }

function ingest(nodes: Map<number, TreeNode>, cdp: CdpNode, parentId: number | null): void {
  const attrs: [string, string][] = []
  const flat = cdp.attributes ?? []
  for (let i = 0; i + 1 < flat.length; i += 2) attrs.push([flat[i], flat[i + 1]])
  nodes.set(cdp.nodeId, {
    id: cdp.nodeId,
    parentId,
    type: cdp.nodeType,
    name: cdp.localName || cdp.nodeName,
    value: cdp.nodeValue,
    attrs,
    childCount: cdp.childNodeCount ?? cdp.children?.length ?? 0,
    children: cdp.children ? cdp.children.map((c) => c.nodeId) : null
  })
  cdp.children?.forEach((child) => ingest(nodes, child, cdp.nodeId))
}

function removeSubtree(nodes: Map<number, TreeNode>, id: number): void {
  nodes.get(id)?.children?.forEach((child) => removeSubtree(nodes, child))
  nodes.delete(id)
}

function findChild(
  nodes: Map<number, TreeNode>,
  parent: TreeNode | undefined,
  name: string
): TreeNode | undefined {
  return parent?.children
    ?.map((id) => nodes.get(id))
    .find((n) => n?.type === NODE_TYPE.element && n.name === name)
}

function reset(root: CdpNode | null): TreeState {
  if (!root) return INITIAL
  const nodes = new Map<number, TreeNode>()
  ingest(nodes, root, null)
  const html = findChild(nodes, nodes.get(root.nodeId), 'html')
  const body = findChild(nodes, html, 'body')
  const expanded = new Set([root.nodeId])
  if (html) expanded.add(html.id)
  if (body) expanded.add(body.id)
  return { nodes, rootId: root.nodeId, expanded, selectedId: null }
}

function applyEvent(state: TreeState, event: DevToolsEvent): TreeState {
  switch (event.method) {
    case 'DOM.setChildNodes': {
      const { parentId, nodes: list } = event.params
      const parent = state.nodes.get(parentId)
      if (!parent) return state
      const nodes = new Map(state.nodes)
      parent.children?.forEach((id) => removeSubtree(nodes, id))
      list.forEach((child) => ingest(nodes, child, parentId))
      nodes.set(parentId, {
        ...parent,
        children: list.map((c) => c.nodeId),
        childCount: list.length
      })
      return { ...state, nodes }
    }
    case 'DOM.childNodeInserted': {
      const { parentNodeId, previousNodeId, node } = event.params
      const parent = state.nodes.get(parentNodeId)
      if (!parent) return state
      const nodes = new Map(state.nodes)
      let children = parent.children
      if (children) {
        ingest(nodes, node, parentNodeId)
        const at = previousNodeId ? children.indexOf(previousNodeId) + 1 : 0
        children = [...children.slice(0, at), node.nodeId, ...children.slice(at)]
      }
      nodes.set(parentNodeId, { ...parent, children, childCount: parent.childCount + 1 })
      return { ...state, nodes }
    }
    case 'DOM.childNodeRemoved': {
      const { parentNodeId, nodeId } = event.params
      const parent = state.nodes.get(parentNodeId)
      if (!parent) return state
      const nodes = new Map(state.nodes)
      removeSubtree(nodes, nodeId)
      nodes.set(parentNodeId, {
        ...parent,
        children: parent.children ? parent.children.filter((id) => id !== nodeId) : null,
        childCount: Math.max(0, parent.childCount - 1)
      })
      return {
        ...state,
        nodes,
        selectedId: state.selectedId !== null && !nodes.has(state.selectedId) ? null : state.selectedId
      }
    }
    case 'DOM.childNodeCountUpdated': {
      const node = state.nodes.get(event.params.nodeId)
      if (!node) return state
      const nodes = new Map(state.nodes)
      nodes.set(node.id, { ...node, childCount: event.params.childNodeCount })
      return { ...state, nodes }
    }
    case 'DOM.attributeModified': {
      const { nodeId, name, value } = event.params
      const node = state.nodes.get(nodeId)
      if (!node) return state
      const attrs = node.attrs.some(([k]) => k === name)
        ? node.attrs.map(([k, v]): [string, string] => (k === name ? [k, value] : [k, v]))
        : [...node.attrs, [name, value] as [string, string]]
      const nodes = new Map(state.nodes)
      nodes.set(nodeId, { ...node, attrs })
      return { ...state, nodes }
    }
    case 'DOM.attributeRemoved': {
      const node = state.nodes.get(event.params.nodeId)
      if (!node) return state
      const nodes = new Map(state.nodes)
      nodes.set(node.id, { ...node, attrs: node.attrs.filter(([k]) => k !== event.params.name) })
      return { ...state, nodes }
    }
    case 'DOM.characterDataModified': {
      const node = state.nodes.get(event.params.nodeId)
      if (!node) return state
      const nodes = new Map(state.nodes)
      nodes.set(node.id, { ...node, value: event.params.characterData })
      return { ...state, nodes }
    }
    case 'Reconix.nodeInspected': {
      const { nodeId } = event.params
      if (!state.nodes.has(nodeId)) return state
      const expanded = new Set(state.expanded)
      for (
        let p = state.nodes.get(nodeId)?.parentId ?? null;
        p !== null;
        p = state.nodes.get(p)?.parentId ?? null
      ) {
        expanded.add(p)
      }
      return { ...state, expanded, selectedId: nodeId }
    }
    default:
      return state
  }
}

function reducer(state: TreeState, action: Action): TreeState {
  switch (action.type) {
    case 'reset':
      return reset(action.root)
    case 'event':
      return applyEvent(state, action.event)
    case 'toggle': {
      const expanded = new Set(state.expanded)
      if (expanded.has(action.id)) expanded.delete(action.id)
      else expanded.add(action.id)
      return { ...state, expanded }
    }
    case 'select':
      return { ...state, selectedId: action.id }
  }
}

// flattens visible part of the tree into display rows
export function buildRows(state: TreeState): TreeRow[] {
  const rows: TreeRow[] = []
  const { nodes, expanded } = state

  const walk = (id: number, depth: number): void => {
    const node = nodes.get(id)
    if (!node) return
    const push = (kind: TreeRowKind, suffix = ''): void => {
      rows.push({ key: `${id}${suffix}`, id, depth, kind })
    }

    switch (node.type) {
      case NODE_TYPE.document:
        node.children?.forEach((child) => walk(child, depth))
        break
      case NODE_TYPE.doctype:
        push('doctype')
        break
      case NODE_TYPE.text:
        if (node.value.trim()) push('text')
        break
      case NODE_TYPE.comment:
        push('comment')
        break
      case NODE_TYPE.element: {
        const kids = node.children
        const onlyChild = kids && kids.length === 1 ? nodes.get(kids[0]) : undefined
        if (onlyChild?.type === NODE_TYPE.text) push('inline')
        else if (node.childCount === 0) push('leaf')
        else if (!expanded.has(id)) push('collapsed')
        else {
          push('open')
          kids?.forEach((child) => walk(child, depth + 1))
          push('close', ':close')
        }
        break
      }
    }
  }

  if (state.rootId !== null) walk(state.rootId, 0)
  return rows
}

export function useDomTree(): {
  state: TreeState
  loaded: boolean
  toggle: (id: number) => void
  select: (id: number | null) => void
} {
  const [state, dispatch] = useReducer(reducer, INITIAL)
  const requested = useRef(new Set<number>())
  const loadCount = useRef(0)

  const load = useCallback(async () => {
    const ticket = ++loadCount.current
    const root = await window.reconix.devtools.getDocument()
    if (ticket !== loadCount.current) return
    requested.current.clear()
    dispatch({ type: 'reset', root })
  }, [])

  useEffect(() => {
    void load()
    return window.reconix.devtools.onEvent((event) => {
      if (event.method === 'DOM.documentUpdated') void load()
      else dispatch({ type: 'event', event })
    })
  }, [load])

  // lazily fetching children of any expanded node that doesnt have them yet
  useEffect(() => {
    for (const id of state.expanded) {
      const node = state.nodes.get(id)
      if (node && node.children === null && node.childCount > 0 && !requested.current.has(id)) {
        requested.current.add(id)
        void window.reconix.devtools.requestChildren(id)
      }
    }
  }, [state.expanded, state.nodes])

  const toggle = useCallback((id: number) => dispatch({ type: 'toggle', id }), [])
  const select = useCallback((id: number | null) => dispatch({ type: 'select', id }), [])

  return { state, loaded: state.rootId !== null, toggle, select }
}

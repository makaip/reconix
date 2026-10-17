import { NODE_TYPE, type TreeNode } from '../hooks/useDomTree'

const attr = (node: TreeNode, name: string): string | undefined =>
  node.attrs.find(([key]) => key === name)?.[1]

const classesOf = (node: TreeNode): string[] =>
  attr(node, 'class')?.trim().split(/\s+/).filter(Boolean) ?? []

/** e.g. `main#orders`, `div.filters`, `body.app`. */
export function crumbLabel(node: TreeNode): string {
  const id = attr(node, 'id')
  const classes = classesOf(node)
  return `${node.name}${id ? `#${id}` : ''}${classes.length ? `.${classes.join('.')}` : ''}`
}

/** e.g. `<table.orders-table>`, as shown on Copilot context chips. */
export const chipLabel = (node: TreeNode): string => `<${crumbLabel(node)}>`

/** Builds a CSS selector path from the nearest `#id` ancestor (or `html`) down to the node. */
export function cssSelector(nodes: Map<number, TreeNode>, id: number): string {
  const parts: string[] = []
  for (
    let node = nodes.get(id);
    node && node.type === NODE_TYPE.element;
    node = node.parentId === null ? undefined : nodes.get(node.parentId)
  ) {
    const elementId = attr(node, 'id')
    if (elementId) {
      parts.unshift(`${node.name}#${CSS.escape(elementId)}`)
      break
    }
    let part = node.name + classesOf(node).map((c) => `.${CSS.escape(c)}`).join('')
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId)
    const sameTag = (parent?.children ?? [])
      .map((childId) => nodes.get(childId))
      .filter((n) => n?.type === NODE_TYPE.element && n.name === node?.name)
    if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`
    parts.unshift(part)
  }
  return parts.join(' > ')
}

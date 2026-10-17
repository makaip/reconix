import { useEffect, useRef, type KeyboardEvent } from 'react'
import type { TreeNode, TreeRow, TreeState } from '../../hooks/useDomTree'
import { NODE_TYPE } from '../../hooks/useDomTree'
import { chipLabel, cssSelector } from '../../lib/domLabel'
import { NODE_DRAG_TYPE, type NodeDragItem } from '../../lib/dragTypes'

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'
])

// collapses whitespace and truncates so multi-line text stays on one tree row
function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function OpenTag({ node }: { node: TreeNode }): JSX.Element {
  return (
    <>
      <span className="dt-tag">{`<${node.name}`}</span>
      {node.attrs.map(([name, value]) => (
        <span key={name}>
          {' '}
          <span className="dt-attr">{name}</span>=<span className="dt-string">{`"${value}"`}</span>
        </span>
      ))}
      <span className="dt-tag">{'>'}</span>
    </>
  )
}

function CloseTag({ node }: { node: TreeNode }): JSX.Element {
  return <span className="dt-tag">{`</${node.name}>`}</span>
}

function RowContent({ row, node, nodes }: { row: TreeRow; node: TreeNode; nodes: Map<number, TreeNode> }): JSX.Element {
  switch (row.kind) {
    case 'doctype':
      return (
        <>
          <span className="dt-tag">{'<!DOCTYPE'}</span>
          {` ${node.name}`}
          <span className="dt-tag">{'>'}</span>
        </>
      )
    case 'open':
      return <OpenTag node={node} />
    case 'collapsed':
      return (
        <>
          <OpenTag node={node} />
          <span className="dt-muted">…</span>
          <CloseTag node={node} />
        </>
      )
    case 'inline': {
      const text = node.children ? oneLine(nodes.get(node.children[0])?.value ?? '') : ''
      return (
        <>
          <OpenTag node={node} />
          {text}
          <CloseTag node={node} />
        </>
      )
    }
    case 'leaf':
      return (
        <>
          <OpenTag node={node} />
          {!VOID_ELEMENTS.has(node.name) && <CloseTag node={node} />}
        </>
      )
    case 'close':
      return <CloseTag node={node} />
    case 'text':
      return <>{`"${oneLine(node.value)}"`}</>
    case 'comment':
      return <span className="dt-muted">{`<!--${oneLine(node.value)}-->`}</span>
  }
}

type ElementsTreeProps = {
  state: TreeState
  rows: TreeRow[]
  /** Every node in the current multi-selection (highlighted). */
  selectedIds: Set<number>
  /** Click with modifier info, so cmd/ctrl toggles and shift ranges. */
  onSelectRow: (id: number, mods: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void
  /** Sets the active node (keyboard nav); collapses the multi-selection to it. */
  onSelect: (id: number) => void
  onToggle: (id: number) => void
  onHover: (id: number | null) => void
  onDragStart: () => void
  onDragEnd: () => void
}

function ElementsTree({
  state,
  rows,
  selectedIds,
  onSelectRow,
  onSelect,
  onToggle,
  onHover,
  onDragStart,
  onDragEnd
}: ElementsTreeProps): JSX.Element {
  const selectable = rows.filter((row) => row.kind !== 'close')
  const treeRef = useRef<HTMLDivElement>(null)

  // Builds the drag payload: the whole selection when the dragged row is part of it, else just it.
  const dragItems = (id: number): NodeDragItem[] => {
    const ids = selectedIds.has(id) && selectedIds.size > 1 ? [...selectedIds] : [id]
    return ids
      .map((nodeId) => state.nodes.get(nodeId))
      .filter((node): node is TreeNode => node?.type === NODE_TYPE.element)
      .map((node) => ({
        nodeId: node.id,
        label: chipLabel(node),
        selector: cssSelector(state.nodes, node.id)
      }))
  }

  // keeps the selection on screen, e.g. after picking a deeply nested element in the page
  useEffect(() => {
    treeRef.current?.querySelector('.dt-row--selected')?.scrollIntoView({ block: 'nearest' })
  }, [state.selectedId])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = selectable.findIndex((row) => row.id === state.selectedId)
    const current = selectable[index]
    const node = current ? state.nodes.get(current.id) : undefined

    if (event.key === 'ArrowDown') onSelect(selectable[Math.min(index + 1, selectable.length - 1)]?.id)
    else if (event.key === 'ArrowUp') onSelect(selectable[Math.max(index - 1, 0)]?.id)
    else if (event.key === 'ArrowRight' && current?.kind === 'collapsed') onToggle(current.id)
    else if (event.key === 'ArrowRight' && current?.kind === 'open') onSelect(selectable[index + 1]?.id)
    else if (event.key === 'ArrowLeft' && current?.kind === 'open') onToggle(current.id)
    else if (event.key === 'ArrowLeft' && node?.parentId && state.nodes.get(node.parentId)?.type === 1) {
      onSelect(node.parentId)
    } else return
    event.preventDefault()
  }

  return (
    <div
      ref={treeRef}
      className="dt-tree"
      role="tree"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onMouseLeave={() => onHover(null)}
    >
      <div className="dt-tree__list">
        {rows.map((row) => {
          const node = state.nodes.get(row.id)
          if (!node) return null
          const selected = selectedIds.has(row.id) && row.kind !== 'close'
          const active = row.id === state.selectedId && row.kind !== 'close'
          const expandable = row.kind === 'open' || row.kind === 'collapsed'
          const isElement = node.type === 1
          return (
            <div
              key={row.key}
              role="treeitem"
              aria-selected={selected}
              className={selected ? 'dt-row dt-row--selected' : 'dt-row'}
              style={{ paddingLeft: 10 + row.depth * 16 }}
              draggable={isElement}
              onClick={(event) =>
                onSelectRow(row.id, {
                  metaKey: event.metaKey,
                  ctrlKey: event.ctrlKey,
                  shiftKey: event.shiftKey
                })
              }
              onMouseEnter={() => onHover(isElement ? row.id : null)}
              onDragStart={(event) => {
                if (!isElement) return
                const items = dragItems(row.id)
                if (items.length === 0) {
                  event.preventDefault()
                  return
                }
                event.dataTransfer.effectAllowed = 'copy'
                event.dataTransfer.setData(NODE_DRAG_TYPE, JSON.stringify(items))
                event.dataTransfer.setData('text/plain', items.map((item) => item.label).join('\n'))
                onHover(null)
                onDragStart()
              }}
              onDragEnd={onDragEnd}
            >
              <span
                className="dt-row__arrow"
                aria-hidden="true"
                onClick={
                  expandable
                    ? (event) => {
                        event.stopPropagation()
                        onToggle(row.id)
                      }
                    : undefined
                }
              >
                {row.kind === 'open' ? '▼' : row.kind === 'collapsed' ? '▶' : ''}
              </span>
              <RowContent row={row} node={node} nodes={state.nodes} />
              {active && isElement && <span className="dt-muted">{' == $0'}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default ElementsTree

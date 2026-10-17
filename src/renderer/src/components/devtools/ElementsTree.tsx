import type { KeyboardEvent } from 'react'
import type { TreeNode, TreeRow, TreeState } from '../../hooks/useDomTree'

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
  onSelect: (id: number) => void
  onToggle: (id: number) => void
  onHover: (id: number | null) => void
}

function ElementsTree({ state, rows, onSelect, onToggle, onHover }: ElementsTreeProps): JSX.Element {
  const selectable = rows.filter((row) => row.kind !== 'close')

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
          const selected = row.id === state.selectedId && row.kind !== 'close'
          const expandable = row.kind === 'open' || row.kind === 'collapsed'
          const isElement = node.type === 1
          return (
            <div
              key={row.key}
              role="treeitem"
              aria-selected={selected}
              className={selected ? 'dt-row dt-row--selected' : 'dt-row'}
              style={{ paddingLeft: 10 + row.depth * 16 }}
              onClick={() => onSelect(row.id)}
              onMouseEnter={() => onHover(isElement ? row.id : null)}
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
              {selected && isElement && <span className="dt-muted">{' == $0'}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default ElementsTree

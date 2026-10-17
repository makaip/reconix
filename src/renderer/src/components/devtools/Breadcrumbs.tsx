import { NODE_TYPE, type TreeNode, type TreeState } from '../../hooks/useDomTree'
import { crumbLabel } from '../../lib/domLabel'

function Breadcrumbs({ state }: { state: TreeState }): JSX.Element {
  const trail: TreeNode[] = []
  for (
    let node = state.selectedId === null ? undefined : state.nodes.get(state.selectedId);
    node;
    node = node.parentId === null ? undefined : state.nodes.get(node.parentId)
  ) {
    if (node.type === NODE_TYPE.element) trail.unshift(node)
  }

  return (
    <nav className="dt-breadcrumbs" aria-label="Breadcrumbs">
      {trail.map((node, index) => (
        <span
          key={node.id}
          className={index === trail.length - 1 ? 'dt-breadcrumbs__crumb dt-breadcrumbs__crumb--current' : 'dt-breadcrumbs__crumb'}
        >
          {crumbLabel(node)}
        </span>
      ))}
    </nav>
  )
}

export default Breadcrumbs

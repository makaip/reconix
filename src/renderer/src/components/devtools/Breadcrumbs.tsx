import { NODE_TYPE, type TreeNode, type TreeState } from '../../hooks/useDomTree'

function crumbLabel(node: TreeNode): string {
  const id = node.attrs.find(([k]) => k === 'id')?.[1]
  const classes = node.attrs.find(([k]) => k === 'class')?.[1].trim().split(/\s+/).filter(Boolean)
  return `${node.name}${id ? `#${id}` : ''}${classes?.length ? `.${classes.join('.')}` : ''}`
}

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

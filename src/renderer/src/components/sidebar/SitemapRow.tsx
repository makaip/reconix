import fileMuted from '../../assets/icons/file-muted.svg'
import type { SitemapNode } from '../../lib/sitemap'

type SitemapRowProps = {
  node: SitemapNode
  selected: boolean
  onSelect: (id: string) => void
}

function SitemapRow({ node, selected, onSelect }: SitemapRowProps): JSX.Element {
  return (
    <button
      type="button"
      className={[
        'sitemap-row',
        node.kind === 'folder' && 'sitemap-row--folder',
        selected && 'sitemap-row--selected'
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ paddingLeft: 10 + node.depth * 14 }}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(node.id)}
    >
      <img src={fileMuted} width={13} height={13} alt="" />
      <span className="sitemap-row__label">{node.label}</span>
    </button>
  )
}

export default SitemapRow

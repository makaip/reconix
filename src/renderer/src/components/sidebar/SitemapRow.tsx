import fileAmber from '../../assets/icons/file-amber.svg'
import fileMuted from '../../assets/icons/file-muted.svg'
import type { SitemapNode } from '../../mock/data'

type SitemapRowProps = {
  node: SitemapNode
  selected: boolean
  onSelect: (id: string) => void
}

function SitemapRow({ node, selected, onSelect }: SitemapRowProps): JSX.Element {
  return (
    <button
      type="button"
      className={selected ? 'sitemap-row sitemap-row--selected' : 'sitemap-row'}
      style={{ paddingLeft: 8 + node.depth * 14 }}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(node.id)}
    >
      <img src={node.kind === 'folder' ? fileAmber : fileMuted} width={13} height={13} alt="" />
      <span className="sitemap-row__label">{node.label}</span>
    </button>
  )
}

export default SitemapRow

import { useState } from 'react'
import plus from '../../assets/icons/plus.svg'
import { findings, sitemap } from '../../mock/data'
import FindingCard from './FindingCard'
import SectionHeader from './SectionHeader'
import SitemapRow from './SitemapRow'

function Sidebar(): JSX.Element {
  const [selectedId, setSelectedId] = useState('dashboard')

  return (
    <aside className="sidebar" aria-label="Sitemap and findings">
      <div className="sidebar__scroll">
        <SectionHeader label="Sitemap" count={sitemap.length} />
        {sitemap.map((node) => (
          <SitemapRow
            key={node.id}
            node={node}
            selected={node.id === selectedId}
            onSelect={setSelectedId}
          />
        ))}

        <SectionHeader label="Findings" count={findings.length} />
        {findings.map((finding) => (
          <FindingCard key={finding.id} finding={finding} />
        ))}
      </div>

      <button type="button" className="add-note">
        <img src={plus} width={13} height={13} alt="" />
        <span>Add note to engagement</span>
      </button>
    </aside>
  )
}

export default Sidebar

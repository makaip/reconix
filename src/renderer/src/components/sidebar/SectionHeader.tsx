import Badge from '../Badge'

type SectionHeaderProps = {
  label: string
  count: number
  badgeTone?: 'muted' | 'raised'
}

function SectionHeader({ label, count, badgeTone = 'raised' }: SectionHeaderProps): JSX.Element {
  return (
    <div className="section-header">
      <h2 className="section-header__label">{label}</h2>
      <Badge tone={badgeTone}>{count}</Badge>
    </div>
  )
}

export default SectionHeader

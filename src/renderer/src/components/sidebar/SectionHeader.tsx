type SectionHeaderProps = {
  label: string
  count: number
}

function SectionHeader({ label, count }: SectionHeaderProps): JSX.Element {
  return (
    <div className="section-header">
      <h2 className="section-header__label">{label}</h2>
      <span className="section-header__count">{count}</span>
    </div>
  )
}

export default SectionHeader

import type { Finding, FindingSeverity } from '../../../../shared/findings'

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  critical: 'Crit',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info'
}

function FindingCard({ finding }: { finding: Finding }): JSX.Element {
  return (
    <button type="button" className="finding-card">
      <span className={`finding-card__severity finding-card__severity--${finding.severity}`}>
        {SEVERITY_LABEL[finding.severity]}
      </span>
      <span className="finding-card__title">{finding.title}</span>
    </button>
  )
}

export default FindingCard

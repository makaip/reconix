import type { Finding, Severity } from '../../mock/data'

const SEVERITY_LABEL: Record<Severity, string> = {
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

import type { Finding, FindingSeverity, FindingStatus } from '../../../../shared/findings'

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  critical: 'Crit',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info'
}

const STATUS_LABEL: Record<FindingStatus, string> = {
  open: 'Open',
  confirmed: 'Confirmed',
  'false-positive': 'False positive',
  fixed: 'Fixed'
}

type FindingCardProps = {
  finding: Finding
  /** Opens the triage detail panel for this finding. */
  onOpen: (id: string) => void
  selected?: boolean
}

function FindingCard({ finding, onOpen, selected = false }: FindingCardProps): JSX.Element {
  // Untouched findings omit `status`, which is equivalent to 'open' — only show
  // a badge once an analyst has actually triaged it.
  const status = finding.status ?? 'open'
  return (
    <button
      type="button"
      className={`finding-card${selected ? ' finding-card--selected' : ''}`}
      onClick={() => onOpen(finding.id)}
      title={finding.title}
    >
      <span className={`finding-card__severity finding-card__severity--${finding.severity}`}>
        {SEVERITY_LABEL[finding.severity]}
      </span>
      <span className="finding-card__title">{finding.title}</span>
      {status !== 'open' && (
        <span className={`finding-card__status finding-card__status--${status}`}>{STATUS_LABEL[status]}</span>
      )}
      {typeof finding.cvss === 'number' && (
        <span className="finding-card__cvss" title="CVSS base score">
          {finding.cvss.toFixed(1)}
        </span>
      )}
    </button>
  )
}

export default FindingCard

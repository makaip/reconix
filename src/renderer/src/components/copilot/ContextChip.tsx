import chipX from '../../assets/icons/chip-x.svg'

type ContextChipProps = {
  label: string
  onRemove?: () => void
}

function ContextChip({ label, onRemove }: ContextChipProps): JSX.Element {
  return (
    <span className="context-chip">
      <span className="context-chip__label">{label}</span>
      <button type="button" className="context-chip__remove" aria-label={`Remove ${label}`} onClick={onRemove}>
        <img src={chipX} width={12} height={12} alt="" />
      </button>
    </span>
  )
}

export default ContextChip

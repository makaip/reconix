import { useRef } from 'react'
import { useBoundsReporter, type Bounds } from '../hooks/useBoundsReporter'

type ViewSlotProps = {
  onBoundsChange: (bounds: Bounds) => void
  className?: string
}

/** reserved space for native WebContentsView */
function ViewSlot({ onBoundsChange, className }: ViewSlotProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useBoundsReporter(ref, onBoundsChange)
  return <div ref={ref} className={className ? `view-slot ${className}` : 'view-slot'} />
}

export default ViewSlot

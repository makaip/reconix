import { useCallback, useRef } from 'react'
import { useBoundsReporter, type Bounds } from '../hooks/useBoundsReporter'

type ViewSlotProps = {
  onBoundsChange: (bounds: Bounds) => void
  className?: string
  agentActive?: boolean
}

/** reserved space for native WebContentsView */
function ViewSlot({ onBoundsChange, className, agentActive = false }: ViewSlotProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const reportBounds = useCallback(
    (bounds: Bounds) => {
      if (!agentActive) return onBoundsChange(bounds)
      const edge = 4
      onBoundsChange({
        x: bounds.x + edge,
        y: bounds.y + edge,
        width: Math.max(0, bounds.width - edge * 2),
        height: Math.max(0, bounds.height - edge * 2)
      })
    },
    [agentActive, onBoundsChange]
  )
  useBoundsReporter(ref, reportBounds)
  const classes = ['view-slot', className, agentActive ? 'view-slot--agent-active' : ''].filter(Boolean).join(' ')
  return <div ref={ref} className={classes} />
}

export default ViewSlot

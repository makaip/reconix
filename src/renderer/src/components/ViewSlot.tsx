import { forwardRef } from 'react'

type ViewSlotProps = {
  /** imma put native view over this slot later */
  view: 'page' | 'devtools'
  className?: string
}

/**
 * empty layout box. main process will later position the view over this element's bounds
 */
const ViewSlot = forwardRef<HTMLDivElement, ViewSlotProps>(function ViewSlot(
  { view, className },
  ref
) {
  return (
    <div
      ref={ref}
      className={className ? `view-slot ${className}` : 'view-slot'}
      data-view-slot={view}
    />
  )
})

export default ViewSlot

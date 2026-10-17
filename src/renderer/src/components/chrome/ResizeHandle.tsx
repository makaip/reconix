import type { PointerEvent } from 'react'

type ResizeHandleProps = {
  orientation: 'vertical' | 'horizontal'
  dragging: boolean
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void
}

/** Thin drag strip between two flex panels. `vertical` resizes width, `horizontal` resizes height. */
function ResizeHandle({ orientation, dragging, onPointerDown }: ResizeHandleProps): JSX.Element {
  return (
    <div
      className={`resize-handle resize-handle--${orientation}${dragging ? ' resize-handle--dragging' : ''}`}
      role="separator"
      aria-orientation={orientation}
      onPointerDown={onPointerDown}
    />
  )
}

export default ResizeHandle

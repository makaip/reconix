import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

type Axis = 'x' | 'y'

type UseResizableOptions = {
  axis: Axis
  initial: number
  min: number
  max: number
  /** Flip the drag direction — for a handle on a panel's trailing edge (right sidebar,
   *  bottom panel) where dragging toward the panel should still grow it. */
  invert?: boolean
  /** Remember the size in localStorage under this key, so it survives remounts and restarts. */
  storageKey?: string
  /** Called when the panel is dragged well past `min`, so the caller can hide it outright. */
  onCollapse?: () => void
}

export type Resizable = {
  size: number
  dragging: boolean
  onHandlePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}

const STORAGE_PREFIX = 'reconix.size.'

function readSize(key: string | undefined, fallback: number, min: number, max: number): number {
  if (!key) return fallback
  try {
    const stored = Number(localStorage.getItem(STORAGE_PREFIX + key))
    return stored ? Math.min(max, Math.max(min, stored)) : fallback
  } catch {
    return fallback
  }
}

/** Drag-to-resize for a single flex panel. Persisted only when `storageKey` is given. */
export function useResizable({
  axis,
  initial,
  min,
  max,
  invert = false,
  storageKey,
  onCollapse
}: UseResizableOptions): Resizable {
  const [size, setSize] = useState(() => readSize(storageKey, initial, min, max))
  const [dragging, setDragging] = useState(false)
  const startSize = useRef(initial)
  const startPos = useRef(0)

  const onHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      startSize.current = size
      startPos.current = axis === 'x' ? event.clientX : event.clientY
      setDragging(true)
      let latest = size

      const onMove = (moveEvent: PointerEvent): void => {
        const pos = axis === 'x' ? moveEvent.clientX : moveEvent.clientY
        const delta = (pos - startPos.current) * (invert ? -1 : 1)
        const raw = startSize.current + delta
        if (onCollapse && raw < min / 2) {
          // keep the pre-drag size so reopening restores it
          latest = startSize.current
          setSize(latest)
          onUp()
          onCollapse()
          return
        }
        latest = Math.min(max, Math.max(min, raw))
        setSize(latest)
      }
      function onUp(): void {
        setDragging(false)
        if (storageKey) {
          try {
            localStorage.setItem(STORAGE_PREFIX + storageKey, String(latest))
          } catch {
            // storage unavailable; the size just won't persist
          }
        }
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [axis, invert, max, min, onCollapse, size, storageKey]
  )

  return { size, dragging, onHandlePointerDown }
}

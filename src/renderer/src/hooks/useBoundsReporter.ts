import { useEffect, type RefObject } from 'react'

export type Bounds = { x: number; y: number; width: number; height: number }

export function useBoundsReporter(
  ref: RefObject<HTMLElement>,
  onChange: (bounds: Bounds) => void
): void {
  useEffect(() => {
    const element = ref.current
    if (!element) return

    let frame = 0
    let last = ''

    const report = (): void => {
      frame = 0
      const { x, y, width, height } = element.getBoundingClientRect()
      const key = `${x}|${y}|${width}|${height}`
      if (key === last) return
      last = key
      onChange({ x, y, width, height })
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(report)
    }

    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    window.addEventListener('resize', schedule)
    schedule()

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [ref, onChange])
}

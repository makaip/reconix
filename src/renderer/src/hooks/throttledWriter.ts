/** Keep the latest snapshot without serializing on every streaming update.
 * The fixed trailing window also saves progress during an uninterrupted stream. */
export function createThrottledWriter<T>(write: (value: T) => void, intervalMs: number): {
  schedule: (value: T) => void
  flush: () => void
} {
  let pending: { value: T } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (!pending) return
    const { value } = pending
    pending = undefined
    write(value)
  }

  return {
    schedule(value) {
      pending = { value }
      if (timer === undefined) timer = setTimeout(flush, intervalMs)
    },
    flush
  }
}

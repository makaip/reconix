import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createThrottledWriter } from './throttledWriter'

describe('createThrottledWriter', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reduces 1,000 streamed snapshots to 20 writes while preserving the complete response', () => {
    const stored: string[] = []
    const write = vi.fn((snapshot: { text: string }) => stored.push(JSON.stringify(snapshot)))
    const persistence = createThrottledWriter(write, 500)
    let text = ''

    for (let i = 0; i < 1_000; i++) {
      text += `${i} `
      persistence.schedule({ text })
      vi.advanceTimersByTime(10)
    }

    expect(write).toHaveBeenCalledTimes(20)
    expect(JSON.parse(stored[0]).text).toBe(Array.from({ length: 50 }, (_, i) => `${i} `).join(''))
    expect(JSON.parse(stored.at(-1)!).text).toBe(text)
    persistence.flush()
    expect(write).toHaveBeenCalledTimes(20)
  })

  it('does no serialization work until the window expires and saves only its latest snapshot', () => {
    const write = vi.fn()
    const persistence = createThrottledWriter<{ text: string }>(write, 500)
    persistence.schedule({ text: 'first' })
    vi.advanceTimersByTime(400)
    persistence.schedule({ text: 'first and last' })
    vi.advanceTimersByTime(99)
    expect(write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(write.mock.calls).toEqual([[{ text: 'first and last' }]])
  })

  it('flushes final tool, approval, and text ordering immediately and cancels the pending timer', () => {
    const write = vi.fn()
    const persistence = createThrottledWriter<{ parts: string[] }>(write, 500)
    persistence.schedule({ parts: ['before', 'tool pending'] })
    persistence.schedule({ parts: ['before', 'tool approved', 'tool complete', 'after'] })

    persistence.flush()
    expect(write.mock.calls).toEqual([[{ parts: ['before', 'tool approved', 'tool complete', 'after'] }]])
    expect(vi.getTimerCount()).toBe(0)
    persistence.flush()
    vi.advanceTimersByTime(1_000)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('cannot overwrite a cleared new chat with a timer from the previous conversation', () => {
    const write = vi.fn()
    const persistence = createThrottledWriter<{ id: string; text: string }>(write, 500)
    persistence.schedule({ id: 'old', text: 'finished response' })
    persistence.flush()
    persistence.schedule({ id: 'new', text: '' })
    persistence.flush()
    vi.advanceTimersByTime(1_000)

    expect(write.mock.calls).toEqual([
      [{ id: 'old', text: 'finished response' }],
      [{ id: 'new', text: '' }]
    ])
  })

  it('continues saving a queued turn after the preceding turn is flushed', () => {
    const write = vi.fn()
    const persistence = createThrottledWriter<string>(write, 500)
    persistence.schedule('first turn')
    persistence.flush()
    persistence.schedule('first turn; second turn')
    vi.advanceTimersByTime(500)

    expect(write.mock.calls).toEqual([['first turn'], ['first turn; second turn']])
  })
})

import { createHash } from 'node:crypto'
import type { AgentEvent } from '../../shared/contracts'

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
      : item
  ) ?? '').digest('hex')
}

/** Bounded, local stall detection. No model calls or timers on the healthy path. */
export class ProgressMonitor {
  private text = ''
  private checkedAt = 0
  private calls = new Map<string, { tool: string; input: string }>()
  private failures: { attempt: string; signature: string }[] = []

  observe(event: AgentEvent): string | undefined {
    if (event.kind === 'message.delta' || event.kind === 'turn.done') {
      if (event.kind === 'message.delta') {
        this.text = (this.text + event.text).slice(-8192)
        this.checkedAt += event.text.length
        if (this.checkedAt < 128) return
      }
      this.checkedAt = 0
      // Detect repeated passages across arbitrary SSE chunk boundaries, including
      // repetitions inside one completion. Require substantial text to avoid
      // matching ordinary repeated words, punctuation or short table cells.
      const text = this.text.replace(/\s+/g, ' ').trim()
      for (let size = 80; size <= Math.min(1024, Math.floor(text.length / 3)); size++) {
        const end = text.length
        if (text.slice(end - size) === text.slice(end - 2 * size, end - size) &&
            text.slice(end - size) === text.slice(end - 3 * size, end - 2 * size)) {
          this.text = ''
          return 'Repeated substantial response text three times without taking a new action.'
        }
      }
    } else if (event.kind === 'tool.call') {
      this.text = ''
      this.checkedAt = 0
      if (this.calls.size >= 64) this.calls.delete(this.calls.keys().next().value!)
      this.calls.set(event.callId, { tool: event.tool, input: fingerprint(event.params) })
    } else if (event.kind === 'tool.result') {
      const call = this.calls.get(event.callId)
      this.calls.delete(event.callId)
      if (!call) return
      const attempt = fingerprint([call.tool, call.input])
      if (event.ok) {
        // Only a successful retry resolves that attempt's failures. An unrelated
        // successful click must not hide a fill → click → fill failure cycle.
        // Successful polling itself never adds a failure.
        this.failures = this.failures.filter((failure) => failure.attempt !== attempt)
        return
      }
      const signature = fingerprint([call.tool, call.input, event.error, event.output])
      this.failures = [...this.failures, { attempt, signature }].slice(-6)
      if (this.failures.filter((failure) => failure.signature === signature).length >= 3) {
        this.failures = []
        // Tool errors/outputs are untrusted: do not embed them as recovery instructions.
        return `The same tool, inputs and failure recurred three times (${call.tool}). Change the approach rather than retrying it.`
      }
    }
    return undefined
  }
}

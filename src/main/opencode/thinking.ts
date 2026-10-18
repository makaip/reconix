/** Qwen can return inline thinking when the remote server has no reasoning
 * parser. Split it locally without another model call or a server restart. */
export class ThinkingStream {
  private states = new Map<string, { session?: string; mode: 'start' | 'reasoning' | 'text'; pending: string; reasoningText: string }>()

  push(message: string, text: string, session?: string): { reasoning: boolean; text: string }[] {
    let state = this.states.get(message)
    if (!state) {
      if (this.states.size >= 64) this.states.delete(this.states.keys().next().value!)
      state = { session, mode: 'start', pending: '', reasoningText: '' }
      this.states.set(message, state)
    }
    state.pending += text
    const parts: { reasoning: boolean; text: string }[] = []
    if (state.mode === 'start') {
      if ('<think>'.startsWith(state.pending)) return parts
      if (state.pending.startsWith('<think>')) {
        state.pending = state.pending.slice(7)
        state.mode = 'reasoning'
      } else state.mode = 'text'
    }
    if (state.mode === 'reasoning') {
      const end = state.pending.indexOf('</think>')
      if (end >= 0) {
        if (end) parts.push({ reasoning: true, text: state.pending.slice(0, end) })
        state.pending = state.pending.slice(end + 8)
        state.mode = 'text'
      } else {
        // Retain only a possible partial closing delimiter between SSE chunks.
        let keep = Math.min(7, state.pending.length)
        while (keep && !'</think>'.startsWith(state.pending.slice(-keep))) keep--
        const ready = state.pending.slice(0, state.pending.length - keep)
        if (ready) parts.push({ reasoning: true, text: ready })
        state.reasoningText = (state.reasoningText + ready).slice(-8192)
        state.pending = state.pending.slice(state.pending.length - keep)
        return parts
      }
    }
    if (state.pending) parts.push({ reasoning: false, text: state.pending })
    state.pending = ''
    return parts
  }

  finish(session?: string, completed = false): { message: string; reasoning: boolean; text: string }[] {
    const tail: { message: string; reasoning: boolean; text: string }[] = []
    for (const [message, state] of this.states) {
      if (state.session !== session) continue
      if (completed && state.mode === 'reasoning' && (state.reasoningText || state.pending)) {
        // The deployed Qwen variant sometimes ends a final answer with an
        // unmatched opening tag. Preserve its output as visible text rather
        // than leaving the completed turn with only a collapsed reasoning row.
        tail.push({ message, reasoning: false, text: state.reasoningText + state.pending })
      } else if (state.pending) tail.push({ message, reasoning: state.mode === 'reasoning', text: state.pending })
      this.states.delete(message)
    }
    return tail
  }
}

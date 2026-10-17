// Main ↔ OpenCode transport (API.md §2). Paths, auth scheme, and request/
// response shapes below are confirmed against a live `opencode serve` (v2
// API, checked 2026-10-17) — NOT guessed. Two things the original guess got
// wrong, worth keeping in mind if OpenCode's beta surface moves again:
//   1. Auth is HTTP Basic with a fixed username "opencode", not Bearer.
//   2. Every route lives under /api — bare paths like /health 404 (well,
//      200-with-the-SPA-shell, which is worse: it *looks* like success).

export interface OpenCodeConfig {
  baseUrl: string // http://127.0.0.1:<hostPort>
  password: string // printed by `opencode serve` on startup
  /** Agent ID to pin new sessions to (opencode.json's `agents.*` key). Falls
   *  back to OpenCode's own default agent ("build") when omitted. */
  agent?: string
}

export interface RawEvent {
  type: string
  [k: string]: unknown
}

// Logical surface the connector needs. A real impl may delegate to
// @opencode-ai/sdk instead of hand-rolled fetch.
export interface OpenCodeTransport {
  health(): Promise<boolean>
  createSession(): Promise<{ id: string }>
  sendMessage(sessionId: string, text: string): Promise<{ messageId: string }>
  respondPermission(sessionId: string, permissionId: string, decision: string): Promise<void>
  abort(sessionId: string): Promise<void>
  /** SSE stream of raw events; yields until `signal` aborts. */
  subscribe(signal: AbortSignal): AsyncIterable<RawEvent>
}

const PATHS = {
  // No /health route exists; /api/info is the cheapest authenticated 200.
  health: '/api/info',
  session: '/api/session',
  prompt: (id: string) => `/api/session/${id}/prompt`,
  permissionReply: (id: string, pid: string) => `/api/session/${id}/permission/${pid}/reply`,
  interrupt: (id: string) => `/api/session/${id}/interrupt`,
  event: '/api/event'
}

// OpenCode's Permission.Reply enum ("once" | "always" | "reject") doesn't
// line up with our ApprovalDecision ("approve" | "deny" | "edit") — it has
// no concept of "edit" (no modified-params channel), so we fold that into a
// reject: an edit request should come back through as a fresh prompt instead
// of silently mutating what the agent asked for.
function toReply(decision: string): 'once' | 'always' | 'reject' {
  if (decision === 'approve') return 'once'
  return 'reject'
}

export class HttpOpenCodeTransport implements OpenCodeTransport {
  constructor(private readonly cfg: OpenCodeConfig) {}

  private headers(): Record<string, string> {
    const basic = Buffer.from(`opencode:${this.cfg.password}`).toString('base64')
    return { authorization: `Basic ${basic}`, 'content-type': 'application/json' }
  }

  private async req(path: string, init?: RequestInit): Promise<Response> {
    return fetch(this.cfg.baseUrl + path, { ...init, headers: this.headers() })
  }

  async health(): Promise<boolean> {
    try {
      const r = await this.req(PATHS.health)
      return r.ok
    } catch {
      return false
    }
  }

  async createSession(): Promise<{ id: string }> {
    const body = JSON.stringify(this.cfg.agent ? { agent: this.cfg.agent } : {})
    const r = await this.req(PATHS.session, { method: 'POST', body })
    if (!r.ok) throw new Error(`createSession failed: ${r.status}`)
    const { data } = (await r.json()) as { data: { id: string } }
    return { id: data.id }
  }

  async sendMessage(sessionId: string, text: string): Promise<{ messageId: string }> {
    const r = await this.req(PATHS.prompt(sessionId), {
      method: 'POST',
      body: JSON.stringify({ text })
    })
    if (!r.ok) throw new Error(`sendMessage failed: ${r.status}`)
    // Durable-admit response: { data: Session.Inbox.User }, whose id is the
    // *inbox* entry, not the assistant's reply — the reply arrives over /event.
    const { data } = (await r.json()) as { data: { id: string } }
    return { messageId: data.id }
  }

  async respondPermission(sessionId: string, permissionId: string, decision: string): Promise<void> {
    const r = await this.req(PATHS.permissionReply(sessionId, permissionId), {
      method: 'POST',
      body: JSON.stringify({ decision: toReply(decision) })
    })
    if (!r.ok) throw new Error(`respondPermission failed: ${r.status}`)
  }

  async abort(sessionId: string): Promise<void> {
    await this.req(PATHS.interrupt(sessionId), { method: 'POST', body: '{}' })
  }

  async *subscribe(signal: AbortSignal): AsyncIterable<RawEvent> {
    const r = await this.req(PATHS.event, { signal })
    if (!r.ok || !r.body) throw new Error(`event stream failed: ${r.status}`)
    const reader = r.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (!signal.aborted) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      // SSE frames are separated by a blank line; a frame's data lines start "data:".
      let idx: number
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('')
        if (!data) continue
        try {
          // Real frame shape: { id, type, created?, location?, data }. We pass
          // the whole thing through — normalize.ts reads .type and .data.
          yield JSON.parse(data) as RawEvent
        } catch {
          // ignore keep-alive / non-JSON frames
        }
      }
    }
  }
}

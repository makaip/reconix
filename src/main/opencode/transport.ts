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
  /** Model to pin new sessions to, as "providerID/modelID"
   *  (e.g. "google/gemini-3.8-flash"). MUST be set for provider-authed models:
   *  without it, OpenCode ignores the agent's configured model and falls back
   *  to its own hosted gateway, which 403s ("free tier only from within
   *  OpenCode"). Confirmed 2026-10-17 by diffing `opencode run`'s own
   *  POST /api/session body — it always pins the model with a `{providerID,id}`
   *  object (note the field is `id`, not `modelID`). */
  model?: string
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

/** "providerID/modelID" → { providerID, id } (OpenCode's session.model shape;
 *  the model key is `id`, not `modelID`). Only the first slash splits, so
 *  model ids containing slashes survive. Returns undefined if unparseable. */
export function parseModel(spec: string | undefined): { providerID: string; id: string } | undefined {
  if (!spec) return undefined
  const slash = spec.indexOf('/')
  if (slash <= 0 || slash === spec.length - 1) return undefined
  return { providerID: spec.slice(0, slash), id: spec.slice(slash + 1) }
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
    const payload: Record<string, unknown> = {}
    if (this.cfg.agent) payload.agent = this.cfg.agent
    // Pin the model here (not just via agent config) or provider-authed models
    // get bypassed for OpenCode's gateway — see OpenCodeConfig.model.
    const model = parseModel(this.cfg.model)
    if (model) payload.model = model
    const r = await this.req(PATHS.session, { method: 'POST', body: JSON.stringify(payload) })
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

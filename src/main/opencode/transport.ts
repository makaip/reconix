// Main ↔ OpenCode transport (API.md §2). Paths, auth scheme, and request/
// response shapes below are confirmed against a live `opencode serve` (v2
// API, checked 2026-10-17) — NOT guessed. Two things the original guess got
// wrong, worth keeping in mind if OpenCode's beta surface moves again:
//   1. Auth is HTTP Basic with a fixed username "opencode", not Bearer.
//   2. Every route lives under /api — bare paths like /health 404 (well,
//      200-with-the-SPA-shell, which is worse: it *looks* like success).

import { ThinkingStream } from './thinking'

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
  /** Wait for this MCP connection before admitting the session's first prompt. */
  requiredMcpServer?: string
  /** Local URL of that MCP server, probed first so a dead/stale listener fails
   *  fast with an actionable error instead of a 30s "did not connect" timeout. */
  requiredMcpUrl?: string
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
  // "approve all of this type" → OpenCode auto-approves future same-type asks.
  if (decision === 'approve_always') return 'always'
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
  private readonly thinking = new ThinkingStream()
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
    if (this.cfg.requiredMcpServer) await this.waitForMcp(this.cfg.requiredMcpServer)
    return { id: data.id }
  }

  private async waitForMcp(name: string): Promise<void> {
    // OpenCode connects to MCP servers asynchronously after the session is
    // created; /api/mcp can be slow or empty for the first few seconds. A single
    // transient timeout used to abort the whole warm-up, so retry on
    // network/timeout errors instead of failing the session.
    if (this.cfg.requiredMcpUrl) await this.probeLocalMcp(this.cfg.requiredMcpUrl)
    const deadline = Date.now() + 30_000
    let lastErr: unknown
    let seen: string[] = []
    while (Date.now() < deadline) {
      let terminal: Error | null = null
      try {
        const response = await this.req('/api/mcp', { signal: AbortSignal.timeout(8000) })
        if (!response.ok) throw new Error(`MCP readiness check failed: ${response.status}`)
        const { data } = await response.json() as {
          data: { name: string; status: { status: string; error?: string } }[]
        }
        seen = data.map((server) => `${server.name}=${server.status.status}`)
        const entry = data.find((server) => server.name === name)
        const state = entry?.status.status
        if (state === 'connected') return
        if (state === 'failed' || state === 'disabled') {
          terminal = new Error(`Required MCP server ${name} is ${state}${entry?.status.error ? ': ' + entry.status.error : ''}`)
        }
        // absent or still pending — keep polling
      } catch (e) {
        // Transient network/timeout errors are expected during cold start.
        lastErr = e
        console.error('[waitForMcp]', (e as Error)?.name, (e as Error)?.message)
      }
      if (terminal) throw terminal
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(
      `Required MCP server ${name} did not connect within 30s ` +
        `(OpenCode sees: ${seen.length ? seen.join(', ') : 'no MCP servers'}). ` +
        `Last error: ${lastErr instanceof Error ? lastErr.message : lastErr}`
    )
  }

  /**
   * Confirm the local MCP listener actually accepts connections. Any HTTP
   * response counts (the MCP route may answer 405 to a plain GET) — only a
   * refused/timed-out connection is a failure. Gives the operator a precise
   * cause (stale process on the port, firewall) instead of a generic timeout.
   */
  private async probeLocalMcp(url: string): Promise<void> {
    const deadline = Date.now() + 5_000
    let lastErr: unknown
    while (true) {
      try {
        await fetch(url, { method: 'GET', signal: AbortSignal.timeout(1500) })
        return
      } catch (error) {
        lastErr = error
      }
      if (Date.now() >= deadline) {
        const hint = process.platform === 'win32'
          ? 'check `netstat -ano | findstr :4102` and kill the stale PID'
          : 'check `lsof -i :4102` and kill the stale process'
        throw new Error(
          `Reconix MCP server is not reachable at ${url} ` +
            `(${lastErr instanceof Error ? lastErr.message : lastErr}). ` +
            `The port may be held by a stale process — ${hint} — or a firewall is blocking loopback.`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
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
    const response = await this.req(PATHS.interrupt(sessionId), {
      method: 'POST', body: '{}', signal: AbortSignal.timeout(5000)
    })
    if (!response.ok) throw new Error(`interrupt failed: ${response.status}`)
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
          const raw = JSON.parse(data) as RawEvent
          if (this.cfg.model?.startsWith('vllm-orchestrator/')) {
            const d = (raw.data ?? {}) as Record<string, unknown>
            const session = typeof d.sessionID === 'string' ? d.sessionID : undefined
            if (raw.type === 'session.text.delta' && typeof d.assistantMessageID === 'string' && typeof d.delta === 'string') {
              for (const part of this.thinking.push(d.assistantMessageID, d.delta, session)) {
                yield { ...raw, type: part.reasoning ? 'session.reasoning.delta' : 'session.text.delta', data: { ...d, delta: part.text } }
              }
              continue
            }
            if (raw.type.startsWith('session.execution.')) {
              for (const part of this.thinking.finish(session, raw.type === 'session.execution.succeeded')) {
                yield { type: part.reasoning ? 'session.reasoning.delta' : 'session.text.delta', data: { sessionID: session, assistantMessageID: part.message, delta: part.text } }
              }
            }
          }
          yield raw
        } catch {
          // ignore keep-alive / non-JSON frames
        }
      }
    }
  }
}

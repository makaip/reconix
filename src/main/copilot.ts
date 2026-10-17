// Wires the renderer's Copilot panel to a real OpenCode instance (ARCHITECTURE
// §5.B / §6.3), AND gives that OpenCode agent real browser access through
// Reconix's own MCP tool server (§6.2) — previously built and tested in
// isolation (smoke.ts) but never actually reachable by a live agent. Dev-mode
// only for now: spawns `opencode serve` as a child process and talks to it
// over loopback HTTP, same as the eventual Docker setup will once 5.D lands —
// the connector/transport layer doesn't care which one is on the other end.
//
// Model wiring (see ORCHESTRATOR_MODEL / DOM_ANALYZER_MODEL below):
//  - The orchestrator runs on the remote vLLM server configured in reconix.env
//    (ORCHESTRATOR_BASE_URL / ORCHESTRATOR_API_KEY, read by opencode.json's
//    vllm-orchestrator provider). index.ts loads reconix.env into the env the
//    spawned `opencode serve` inherits.
//  - The DOM parser (and the @evaluator subagent) run on the user's Gemini key
//    (via `opencode auth login google` and/or GOOGLE_GENERATIVE_AI_API_KEY).
//    gemini-flash-lite-latest is used because the full gemini-*-flash models cap
//    at 20 requests/day on the free tier, which the background parser alone blows
//    through; flash-lite has a much higher free daily limit.
// Either way the model MUST be pinned on the session we create, or OpenCode
// bypasses the agent's configured model and routes to its own gateway (403).
//
// OpenCode's cwd (`opencode serve`'s working directory) is its PROJECT —
// what its own bash/edit/read tools act on, and where it'd resolve a
// project-local opencode.json. The target site has no local checkout (it's
// a live page reached through the reconix MCP tools below — eval_in_page,
// navigate, etc. — which don't depend on cwd at all). What cwd needs to be
// is an isolated scratch sandbox for bash/file work (saving a payload list,
// a one-off script) — NEVER the Reconix repo; the agent should not get
// edit/bash access to the browser app's own source.
//
// But Reconix's orchestrator/evaluator agents + the reconix MCP server entry
// still need to apply no matter what directory that is. Confirmed live
// (`opencode debug agents` from an unrelated scratch directory) that
// OpenCode's GLOBAL config (~/.config/opencode/, found via `opencode debug
// paths`) is cwd-independent and layers in regardless of project. So:
// Reconix's opencode.json / .opencode/agents/*.md in this repo stay the
// versioned source of truth, and get synced into the global config dir on
// every app start — cwd becomes the sandbox.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'
import { app, ipcMain } from 'electron'
import type { AgentEvent, ApprovalDecision, EngineStatus, Policy, ServerStatus } from '../shared/contracts'
import type { CapturedRequest } from '../shared/tabs'
import type { NetworkCapture } from './network'
import { createOpenCodeConnector, type OpenCodeConnector } from './opencode'
import { parseModel, type RawEvent } from './opencode/transport'
import { buildMcpServer } from './mcp'
import { InMemoryAuditLogger } from './mcp/audit'
import { startMcpHttpServer, type McpHttpServer } from './mcp/server'
import { WebContentsCdpDriver, type CdpDriver, type CookieRecord } from './mcp/cdp'
import { ScopeChecker, type ScopeEnforcer } from './mcp/scope'
import type { FindingSink, HistoryReader, NetworkReader, ToolContext, TraceStore } from './mcp/tool'

const HOST = '127.0.0.1'
const OPENCODE_PORT = 4097
// Models pinned on the sessions we create. Must be set explicitly, not left to
// the agent's config: OpenCode otherwise bypasses the agent model and routes to
// its own hosted gateway, which 403s for provider-authed models (see
// transport.ts's OpenCodeConfig.model). Keep in sync with opencode.json /
// .opencode/agents/*.md. The orchestrator runs on the remote vLLM server
// (reconix.env's ORCHESTRATOR_BASE_URL); the DOM parser runs on the user's
// Gemini key (the vLLM dom server is a separate, often-offline box).
const ORCHESTRATOR_MODEL = 'vllm-orchestrator/orchestrator-model'
const DOM_ANALYZER_MODEL = 'google/gemini-flash-lite-latest'
// Must match opencode.json's mcp.servers.reconix.url — not read back from
// there, since opencode.json is static config and this needs to be a fixed
// port the running process actually binds to.
const MCP_PORT = 4101

export interface CopilotBridge {
  /** Keeps the MCP tool server's CDP driver + scope pointed at the tab the
   *  user is actually looking at. Call on every active-tab change. */
  setActiveTarget(wc: WebContents | null, tabId: number | null): void
  /** Resolves once `opencode serve` + the MCP tool server are both up (or
   *  settles with ok:false if that failed) — never throws. Callers that
   *  gate on this (tabs.ts's navigate handler) should still let the user
   *  proceed on ok:false rather than block forever on a dead engine. */
  waitUntilReady(): Promise<{ ok: boolean; error?: string }>
  stop(): Promise<void>
}

// get_network_log/get_request read from the SAME capture the UI's own
// Network panel uses (main/network.ts) — not a separate collector — scoped
// to whichever tab is active, same policy as ActiveTabCdpDriver/ActiveTabScope.
//
// Takes a getter, not the capture instance itself: index.ts has a real
// ordering constraint — copilotBridge is constructed before tabs/network
// (so the tab manager's synchronous first onActiveChanged call, which fires
// before createTabManager even returns, isn't a no-op), but network capture
// depends on tabs existing first. A getter sidesteps the chicken-and-egg —
// by the time any tool call actually happens, index.ts has long since
// assigned the real instance.
class ActiveTabNetworkReader implements NetworkReader {
  private tabId: number | null = null

  constructor(private readonly getCapture: () => NetworkCapture | undefined) {}

  setActiveTab(tabId: number | null): void {
    this.tabId = tabId
  }

  list(sinceId?: string): CapturedRequest[] {
    if (this.tabId === null) return []
    return this.getCapture()?.list({ tabId: this.tabId, sinceId }) ?? []
  }

  get(id: string): CapturedRequest | undefined {
    const req = this.getCapture()?.get(id)
    return req && req.tabId === this.tabId ? req : undefined
  }
}

// Follows whichever tab is active rather than a single WebContents fixed at
// construction time — tabs can be created/closed/switched for the life of
// the app, but there's one long-lived ToolContext handed to the MCP server.
class ActiveTabCdpDriver implements CdpDriver {
  private current: WebContents | null = null
  private driver: WebContentsCdpDriver | null = null

  constructor(private readonly isUiGuard: (wc: WebContents) => boolean) {}

  setActive(wc: WebContents | null): void {
    if (wc === this.current) return
    this.current = wc
    this.driver = wc ? new WebContentsCdpDriver(wc, this.isUiGuard) : null
  }

  private require(): WebContentsCdpDriver {
    if (!this.driver) throw new Error('no active tab — open a page in the browser first')
    return this.driver
  }

  navigate(url: string): Promise<{ status: number; finalUrl: string }> {
    return this.require().navigate(url)
  }
  pageInfo(): Promise<{ url: string; title: string; readyState: string }> {
    return this.require().pageInfo()
  }
  evaluate(expression: string): Promise<string> {
    return this.require().evaluate(expression)
  }
  screenshot(): Promise<Buffer> {
    return this.require().screenshot()
  }
  cookies(): Promise<CookieRecord[]> {
    return this.require().cookies()
  }
  dispatchInput(events: unknown[]): Promise<void> {
    return this.require().dispatchInput(events)
  }
}

// There's no "start engagement" flow wiring a real scope config yet (the
// renderer's agent:start IPC — src/main/session.ts — is UI-side demo
// scaffolding with a fake task graph, not a real scope). Rather than default
// to allow-all (which would gut the whole point of scope enforcement) or a
// hardcoded placeholder host, this scopes every tool call to whatever site
// is actually open in the active tab right now — re-derived on every check,
// so switching tabs re-scopes automatically.
class ActiveTabScope implements ScopeEnforcer {
  private host: string | null = null

  setActiveHost(host: string | null): void {
    this.host = host
  }

  private checker(): ScopeChecker {
    return new ScopeChecker({
      allowed_hosts: this.host ? [this.host, `*.${this.host}`] : [],
      allowed_cidrs: [],
      denied: [],
      rate_limits: {}
    })
  }

  get config(): ScopeChecker['config'] {
    return this.checker().config
  }
  isInScope(target: string | undefined): boolean {
    return this.checker().isInScope(target)
  }
  assertInScope(target: string | undefined): void {
    this.checker().assertInScope(target)
  }
}

// Fires a single prompt at a named agent (parser) and returns its final text,
// independent of the long-lived orchestrator session/connector — this is a
// background, fire-and-forget job, not part of the user-visible transcript.
// Deliberately raw fetch rather than OpenCodeTransport: that abstraction is
// built around one long-lived streaming session with SSE event fan-out; this
// just needs "ask, poll briefly, get text back, done."
async function runOneShotAgent(
  baseUrl: string,
  password: string,
  agent: string,
  text: string,
  timeoutMs = 25_000
): Promise<string | null> {
  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    'content-type': 'application/json'
  }
  try {
    // Pin the model (not just the agent) — same reason as the orchestrator
    // session: without it the parser routes to OpenCode's gateway and 403s.
    const sessionRes = await fetch(`${baseUrl}/api/session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agent, model: parseModel(DOM_ANALYZER_MODEL) })
    })
    if (!sessionRes.ok) {
      console.error(
        `[copilot] runOneShotAgent(${agent}): POST /api/session failed: ${sessionRes.status} ${await sessionRes.text().catch(() => '')}`
      )
      return null
    }
    const { data: session } = (await sessionRes.json()) as { data: { id: string } }

    const promptRes = await fetch(`${baseUrl}/api/session/${session.id}/prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text })
    })
    if (!promptRes.ok) {
      console.error(
        `[copilot] runOneShotAgent(${agent}): POST /prompt failed: ${promptRes.status} ${await promptRes.text().catch(() => '')}`
      )
      return null
    }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 700))
      const msgRes = await fetch(`${baseUrl}/api/session/${session.id}/message`, { headers })
      if (!msgRes.ok) continue
      const { data: messages } = (await msgRes.json()) as { data: Array<Record<string, unknown>> }
      const assistant = messages.find((m) => m.type === 'assistant' && m.finish)
      if (assistant) {
        const content = (assistant.content as Array<Record<string, unknown>>) ?? []
        return content
          .filter((c) => c.type === 'text')
          .map((c) => String(c.text ?? ''))
          .join('')
      }
      const failed = messages.find((m) => m.type === 'idle' && m.outcome === 'failed')
      if (failed) {
        console.error(`[copilot] runOneShotAgent(${agent}): session reported failed outcome:`, failed)
        return null
      }
    }
    console.error(`[copilot] runOneShotAgent(${agent}): timed out after ${timeoutMs}ms waiting for a reply`)
    return null // timed out — caller falls back to no summary, never blocks on this
  } catch (err) {
    console.error(`[copilot] runOneShotAgent(${agent}): threw:`, err)
    return null
  }
}

// Keeps a running, auto-refreshed summary of the active tab's DOM, produced
// by the `parser` subagent (a fast/cheap model whose whole job is condensing
// raw HTML — see .opencode/agents/parser.md) rather than hand-rolled
// extraction logic. Re-runs on navigation and in-page route changes
// (debounced), independent of whether the user has sent any chat message —
// this is what lets the orchestrator "just know" page structure instead of
// needing eval_in_page/@parser called manually every time.
// Cheap structural fingerprint — NOT a full hash, just enough to notice a
// meaningfully different DOM (SPA re-render, AJAX-injected content) without
// paying for a full outerHTML pull on every poll tick. Element count catches
// added/removed nodes; the length band catches same-count text/attribute
// changes without being thrown off by single-character drift.
const FINGERPRINT_EXPR =
  'document.querySelectorAll("*").length + "/" + Math.round(document.documentElement.outerHTML.length / 200)'

class DomSummaryWatcher {
  private debounceTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private running = false
  private pending = false
  private readonly listeners: Array<() => void> = []
  private latest: { url: string; summary: string } | null = null
  private lastFingerprint: string | null = null

  constructor(
    private readonly getCdp: () => CdpDriver,
    private readonly runParser: (html: string) => Promise<string | null>
  ) {}

  /** Null if there's no summary yet, or it's for a different page than `url`. */
  summaryFor(url: string): string | null {
    return this.latest?.url === url ? this.latest.summary : null
  }

  setActive(wc: WebContents | null): void {
    for (const off of this.listeners) off()
    this.listeners.length = 0
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.latest = null // new tab/page — drop the stale summary until a fresh one lands
    this.lastFingerprint = null
    if (!wc) return
    const trigger = (): void => this.schedule()
    // Electron's .on() overloads need each event name applied separately —
    // a loop over a union-typed array doesn't satisfy them.
    wc.on('did-stop-loading', trigger)
    wc.on('did-navigate-in-page', trigger)
    this.listeners.push(
      () => wc.removeListener('did-stop-loading', trigger),
      () => wc.removeListener('did-navigate-in-page', trigger)
    )
    // did-stop-loading/did-navigate-in-page only fire on real navigations.
    // A lot of real DOM change (SPA routing, AJAX-swapped content) never
    // navigates at all, so poll for a structural fingerprint change too.
    this.pollTimer = setInterval(() => void this.checkMutation(), 2500)
    this.schedule()
  }

  private async checkMutation(): Promise<void> {
    if (this.running) return // the full run already captured current state
    const cdp = this.getCdp()
    const raw = await cdp.evaluate(FINGERPRINT_EXPR).catch(() => null)
    if (raw === null) return
    if (this.lastFingerprint !== null && raw !== this.lastFingerprint) this.schedule()
    this.lastFingerprint = raw
  }

  private schedule(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => void this.run(), 1200)
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.pending = true
      return
    }
    this.running = true
    try {
      const cdp = this.getCdp()
      const info = await cdp.pageInfo().catch((err) => {
        console.error('[copilot] DomSummaryWatcher: pageInfo() failed:', err)
        return null
      })
      if (!info) return
      const raw = await cdp
        .evaluate('document.documentElement.outerHTML.slice(0, 20000)')
        .catch((err) => {
          console.error('[copilot] DomSummaryWatcher: outerHTML evaluate() failed:', err)
          return null
        })
      if (!raw) return
      let html: string
      try {
        html = JSON.parse(raw) as string
      } catch {
        html = raw
      }
      // Fold the fingerprint in here too, so a mutation that lands exactly
      // during a run (and thus got skipped by checkMutation's `running`
      // guard above) doesn't go unnoticed afterwards.
      const fingerprint = await cdp.evaluate(FINGERPRINT_EXPR).catch(() => null)
      const summary = await this.runParser(html)
      if (!summary) {
        console.error(`[copilot] DomSummaryWatcher: @parser produced no summary for ${info.url}`)
      }
      // The page may have navigated again while the parser call was in
      // flight — re-check pageInfo so a stale summary never gets attributed
      // to the wrong url.
      const stillInfo = await cdp.pageInfo().catch(() => null)
      if (summary && stillInfo && stillInfo.url === info.url) {
        this.latest = { url: info.url, summary }
      } else if (summary && stillInfo && stillInfo.url !== info.url) {
        console.error(
          `[copilot] DomSummaryWatcher: discarding stale summary — navigated from ${info.url} to ${stillInfo.url} mid-run`
        )
      }
      if (fingerprint !== null) this.lastFingerprint = fingerprint
    } finally {
      this.running = false
      if (this.pending) {
        this.pending = false
        this.schedule()
      }
    }
  }
}

// In-memory stand-ins for traces/findings/history (ARCHITECTURE §6.4) — B's
// real SQLite-backed store doesn't exist yet. Same stopgap pattern as
// smoke.ts's InMemoryAuditLogger; findings/traces just don't survive a
// restart yet, which is a real gap but not a new one introduced here.
function createInMemorySinks(): { traces: TraceStore; findings: FindingSink; history: HistoryReader } {
  let traceSeq = 0
  let findingSeq = 0
  const findings: unknown[] = []
  return {
    traces: {
      save: async () => `trace_${++traceSeq}`
    },
    findings: {
      record: async (schema, evidenceRef) => {
        const id = `finding_${++findingSeq}`
        findings.push({ id, schema, evidenceRef })
        return id
      }
    },
    history: {
      query: async () => findings
    }
  }
}

const POLICY: Policy = { autoApprove: ['R', 'P'], redactCookies: true, maxToolCallsPerTurn: 100 }

// macOS/Linux XDG path, confirmed live via `opencode debug paths`. OpenCode
// doesn't expose a way to point it at an arbitrary config dir, so this is
// where the sync below has to land. (Windows uses a different base — not a
// concern yet, this whole bridge is dev-mode/macOS-only yself.)
function openCodeGlobalConfigDir(): string {
  return join(homedir(), '.config', 'opencode')
}

/** Copies this repo's opencode.json + .opencode/agents/*.md into OpenCode's
 *  global config dir, so Reconix's agents/mcp entry apply no matter what
 *  directory `opencode serve` is pointed at. Reconix's repo copies stay the
 *  versioned source of truth — this is a one-way sync, never the reverse. */
async function syncGlobalOpenCodeConfig(): Promise<void> {
  const repoRoot = app.getAppPath()
  const globalDir = openCodeGlobalConfigDir()

  const opencodeJson = await readFile(join(repoRoot, 'opencode.json'), 'utf8')
  await writeFile(join(globalDir, 'opencode.json'), opencodeJson)

  const agentsDir = join(repoRoot, '.opencode', 'agents')
  const globalAgentsDir = join(globalDir, 'agents')
  await mkdir(globalAgentsDir, { recursive: true })
  const files = await readdir(agentsDir)
  for (const f of files) {
    if (!f.endsWith('.md')) continue
    await writeFile(join(globalAgentsDir, f), await readFile(join(agentsDir, f), 'utf8'))
  }
}

/** An isolated scratch workspace for OpenCode's bash/edit tools — not the
 *  target site (no local checkout; it's reached live via the MCP tools) and
 *  deliberately not the Reconix repo. Lives under Electron's userData dir,
 *  so it's always available with zero config and persists across runs
 *  (handy for saving a payload list mid-engagement) without risking the
 *  app's own source. */
async function resolveSandboxDir(): Promise<string> {
  const dir = join(app.getPath('userData'), 'opencode-sandbox')
  await mkdir(dir, { recursive: true })
  return dir
}

export function createCopilotBridge(win: BrowserWindow, getNetwork: () => NetworkCapture | undefined): CopilotBridge {
  let child: ChildProcessWithoutNullStreams | null = null
  let connector: OpenCodeConnector | null = null
  let starting: Promise<OpenCodeConnector> | null = null
  let mcpServer: McpHttpServer | null = null
  let mcpStarting: Promise<McpHttpServer> | null = null

  const cdp = new ActiveTabCdpDriver((wc) => wc.id === win.webContents.id)
  const scope = new ActiveTabScope()
  const networkReader = new ActiveTabNetworkReader(getNetwork)

  // Ambient state, prepended to every message sent to the orchestrator so it
  // doesn't have to spend a tool call just to re-orient itself each turn
  // (what page, what origin). Never shown in the renderer's own transcript —
  // the user bubble there is the raw typed text (useCopilot.ts), this prefix
  // only goes to OpenCode.
  async function buildContextPrefix(): Promise<string> {
    try {
      const info = await cdp.pageInfo()
      const origin = (() => {
        try {
          return new URL(info.url).origin
        } catch {
          return info.url
        }
      })()
      const recent = networkReader.list().length
      const header =
        `[Current browser state — url: ${info.url} | origin: ${origin} | ` +
        `title: ${JSON.stringify(info.title)} | readyState: ${info.readyState} | ` +
        `${recent} network request(s) captured for this tab (get_network_log for detail)]`
      const domSummary = domWatcher.summaryFor(info.url)
      const domBlock = domSummary
        ? `\n\n[DOM summary from @parser, auto-refreshed on navigation — not written by the user:]\n${domSummary}`
        : '\n\n[@parser hasn\'t produced a DOM summary for this page yet — call eval_in_page yourself if you need structure right now.]'
      return `${header}${domBlock}\n\n`
    } catch {
      return '' // no active tab yet — don't block the message on it
    }
  }

  const send = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }

  async function spawnServer(): Promise<{ baseUrl: string; password: string }> {
    await syncGlobalOpenCodeConfig()
    const sandboxDir = await resolveSandboxDir()
    return new Promise((resolve, reject) => {
      // Source reconix.env (the remote-vLLM connection) in a shell before exec'ing
      // serve, so bash — not us — handles its `export` + "${VAR}" interpolation.
      // We unset OPENCODE_SERVER_PASSWORD/PORT from it: serve must PRINT a
      // generated password (parsed below) and bind OUR port, not reconix.env's.
      // GOOGLE_* and the rest of process.env (incl. the .env load) are inherited.
      const reconixEnv = join(app.getAppPath(), 'reconix.env')
      const script =
        'if [ -f "$RECONIX_ENV" ]; then set -a; . "$RECONIX_ENV"; set +a; ' +
        'unset OPENCODE_SERVER_PASSWORD OPENCODE_PORT; fi; ' +
        'exec opencode serve --hostname "$1" --port "$2"'
      const proc = spawn('bash', ['-c', script, 'bash', HOST, String(OPENCODE_PORT)], {
        // The scratch sandbox, NOT app.getAppPath() (the Reconix repo) and
        // NOT process.cwd() (wherever the OS launched Electron from).
        // Reconix's own agents/mcp config reach the server regardless, via
        // syncGlobalOpenCodeConfig() above — see the file-header comment.
        cwd: sandboxDir,
        env: { ...process.env, RECONIX_ENV: reconixEnv },
        stdio: 'pipe'
      })
      child = proc
      let url = ''
      let password = ''
      let buf = ''
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('utf8')
        const listeningMatch = buf.match(/server listening on (\S+)/)
        if (listeningMatch) url = listeningMatch[1]
        const passwordMatch = buf.match(/server password (\S+)/)
        if (passwordMatch) password = passwordMatch[1]
        if (url && password) {
          proc.stdout.off('data', onData)
          resolve({ baseUrl: url, password })
        }
      }
      proc.stdout.on('data', onData)
      proc.stderr.on('data', (chunk: Buffer) => console.error('[opencode serve]', chunk.toString('utf8')))
      proc.on('error', reject)
      proc.on('exit', (code) => {
        if (!url || !password) reject(new Error(`opencode serve exited (${code}) before it was ready`))
      })
      setTimeout(() => reject(new Error('opencode serve did not print a listening URL within 15s')), 15_000)
    })
  }

  async function ensureMcpServer(): Promise<McpHttpServer> {
    if (mcpServer) return mcpServer
    if (mcpStarting) return mcpStarting
    mcpStarting = (async () => {
      const sinks = createInMemorySinks()
      const context: ToolContext = {
        engagementId: 'eng_dev',
        scope,
        policy: POLICY,
        cdp,
        network: networkReader,
        ...sinks
      }
      const audit = new InMemoryAuditLogger()
      const registry = buildMcpServer({ audit, context, surface: 'all' })
      const s = await startMcpHttpServer(registry, { port: MCP_PORT })
      mcpServer = s
      return s
    })()
    try {
      return await mcpStarting
    } finally {
      mcpStarting = null
    }
  }

  // Shared by the orchestrator connector AND the background DOM-parser
  // watcher — whichever happens first (first chat message, or just opening
  // a page) boots the shared `opencode serve` process for both.
  let serverInfo: { baseUrl: string; password: string } | null = null
  let serverInfoStarting: Promise<{ baseUrl: string; password: string }> | null = null
  async function ensureServerInfo(): Promise<{ baseUrl: string; password: string }> {
    if (serverInfo) return serverInfo
    if (serverInfoStarting) return serverInfoStarting
    serverInfoStarting = (async () => {
      await ensureMcpServer() // must be up before OpenCode's first tool call
      const info = await spawnServer()
      serverInfo = info
      return info
    })()
    try {
      return await serverInfoStarting
    } finally {
      serverInfoStarting = null
    }
  }

  // Eagerly warms the engine the moment the bridge is created (app launch),
  // instead of lazily on first chat message/navigation — that lazy path is
  // what caused the cold-start race where a quick first navigation got "no
  // DOM summary yet" because `opencode serve` hadn't finished booting. The
  // renderer gates on `waitUntilReady()` below (surfaced as a loading
  // overlay) so the user sees why, instead of hitting a silent race.
  //
  // The status is RETAINED (not just pushed): the bridge is created before the
  // renderer has even loaded, and the engine often reaches 'ready' before React
  // mounts and subscribes — so a push-only channel loses the transition and the
  // loading banner hangs on 'starting' forever. The renderer reads this back via
  // `copilot:get-engine-status` on mount, and the push is only an optimization
  // for the case where it did subscribe in time.
  let engineStatus: EngineStatus = { status: 'starting' }
  const setEngineStatus = (next: EngineStatus): void => {
    engineStatus = next
    send('copilot:engine-status', next)
  }

  setEngineStatus({ status: 'starting' })
  const engineReady: Promise<{ ok: boolean; error?: string }> = ensureServerInfo().then(
    () => {
      setEngineStatus({ status: 'ready' })
      return { ok: true }
    },
    (err: unknown) => {
      const error = err instanceof Error ? err.message : String(err)
      console.error('[copilot] engine warm-up failed:', err)
      setEngineStatus({ status: 'error', error })
      return { ok: false, error }
    }
  )

  ipcMain.handle('copilot:get-engine-status', () => engineStatus)

  const domWatcher = new DomSummaryWatcher(
    () => cdp,
    async (html) => {
      const { baseUrl, password } = await ensureServerInfo().catch(() => ({ baseUrl: '', password: '' }))
      if (!baseUrl) return null
      return runOneShotAgent(baseUrl, password, 'dom-analyzer', html)
    }
  )

  async function ensureConnector(): Promise<OpenCodeConnector> {
    if (connector) return connector
    if (starting) return starting
    starting = (async () => {
      const { baseUrl, password } = await ensureServerInfo()
      const c = createOpenCodeConnector(
        { baseUrl, password, agent: 'pentest-orchestrator', model: ORCHESTRATOR_MODEL },
        {
          onAgentEvent: (ev: AgentEvent) => send('copilot:event', ev),
          persist: (_raw: RawEvent, _normalized: AgentEvent | null) => {
            // TODO(B): write through to the engagement store (§6.4) once it
            // exists. Dropped on the floor for now — not a regression, there
            // was no store before this either.
          },
          onStatus: (status: ServerStatus) => send('copilot:status', status)
        }
      )
      await c.start()
      connector = c
      return c
    })()
    try {
      return await starting
    } finally {
      starting = null
    }
  }

  ipcMain.handle('copilot:send', async (_event, text: string) => {
    const c = await ensureConnector()
    const prefix = await buildContextPrefix()
    return c.sendMessage(prefix + String(text))
  })

  ipcMain.handle('copilot:respond-approval', async (_event, approvalId: string, decision: ApprovalDecision) => {
    const c = await ensureConnector()
    return c.respondApproval(String(approvalId), decision)
  })

  ipcMain.handle('copilot:interrupt', async () => {
    const c = await ensureConnector()
    return c.interrupt()
  })

  return {
    setActiveTarget(wc, tabId) {
      cdp.setActive(wc)
      networkReader.setActiveTab(tabId)
      domWatcher.setActive(wc)
      try {
        scope.setActiveHost(wc ? new URL(wc.getURL()).hostname || null : null)
      } catch {
        scope.setActiveHost(null) // about:blank and friends aren't parseable URLs
      }
    },
    waitUntilReady() {
      return engineReady
    },
    async stop() {
      ipcMain.removeHandler('copilot:send')
      ipcMain.removeHandler('copilot:respond-approval')
      ipcMain.removeHandler('copilot:interrupt')
      ipcMain.removeHandler('copilot:get-engine-status')
      domWatcher.setActive(null)
      await connector?.stop().catch(() => undefined)
      await mcpServer?.stop().catch(() => undefined)
      child?.kill()
    }
  }
}

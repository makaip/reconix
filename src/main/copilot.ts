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
//  - The DOM parser (and the @evaluator subagent) run through the custom
//    `gemini` provider using GOOGLE_GENERATIVE_AI_API_KEY directly.
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
import { readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { setQuestionSender } from './questionBridge'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'
import { app, ipcMain } from 'electron'
import type {
  AgentEvent,
  ApprovalDecision,
  EngineStatus,
  Policy,
  ServerStatus,
  UsageSnapshot
} from '../shared/contracts'
import type { CapturedRequest, InterceptRule } from '../shared/tabs'
import type { NetworkCapture } from './network'
import {
  createOpenCodeConnector,
  mergeConfig,
  UsageMeter,
  type JsonObject,
  type OpenCodeConnector
} from './opencode'
import { parseModel, type RawEvent } from './opencode/transport'
import { buildMcpServer } from './mcp'
import { startMcpHttpServer, type McpHttpServer } from './mcp/server'
import {
  WebContentsCdpDriver,
  type CdpDriver,
  type CookieRecord,
  type EmulationOptions,
  type HttpRequestSpec,
  type HttpReplayResult
} from './mcp/cdp'
import { ScopeChecker, type ScopeEnforcer } from './mcp/scope'
import type { NetworkReader, ToolContext } from './mcp/tool'
import { openDatabase } from './db'
import { createFindingsStore } from './findings'
import { createEngagementStore } from './engagements'
import { createTraceStore } from './traces'
import { createAuditLogger } from './auditLog'
import { createHistoryReader } from './history'

const HOST = '127.0.0.1'
const OPENCODE_PORT = 4097
// Models pinned on the sessions we create. Must be set explicitly, not left to
// the agent's config: OpenCode otherwise bypasses the agent model and routes to
// its own hosted gateway, which 403s for provider-authed models (see
// transport.ts's OpenCodeConfig.model). Keep in sync with opencode.json /
// .opencode/agents/*.md. The orchestrator runs on the remote vLLM server
// (reconix.env's ORCHESTRATOR_BASE_URL); the DOM parser (and the evaluator
// subagent) run on OpenCode Zen's free Grok Code model.
const ORCHESTRATOR_MODEL = 'vllm-orchestrator/orchestrator-model'
// OpenCode Zen's built-in `opencode` provider (grok-code-fast-1, free). Unlike
// the provider-authed models above, this one IS served by OpenCode's own
// gateway, so pinning the model id here routes to the gateway as intended
// rather than 403ing. Auth comes from `opencode auth login` (the OpenCode Zen
// key), not a provider block in opencode.json.
const DOM_ANALYZER_MODEL = 'opencode/grok-code'
// Must match opencode.json's mcp.servers.reconix.url — not read back from
// there, since opencode.json is static config and this needs to be a fixed
// port the running process actually binds to.
const MCP_PORT = 4102
// Once the local engine has booted, how often to re-check that the orchestrator
// MODEL backend (the remote vLLM server in reconix.env) is still reachable.
// `opencode serve` being up says nothing about the model being up, so without
// this the indicator would sit on "ready" against a dead backend.
const PROVIDER_PROBE_INTERVAL_MS = 15_000

// ── spawned `opencode serve` lifecycle ───────────────────────────────────────
// Processes we've spawned and must not leave behind. A module-level set plus a
// single process 'exit' hook is the last-resort safety net for exits that
// don't route through the bridge's stop() (a crash, a dev reload, process.exit):
// we synchronously SIGKILL each server's whole process group.
const liveServers = new Set<ChildProcessWithoutNullStreams>()
let exitHookInstalled = false

/**
 * Signal a spawned server's whole process group. It is spawned detached, so it
 * leads its own group — a negative pid therefore reaches anything `opencode
 * serve` itself forked, not just the direct child.
 */
function signalGroup(proc: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (proc.pid === undefined) return
  try {
    process.kill(-proc.pid, signal)
  } catch {
    try {
      proc.kill(signal)
    } catch {
      // Already gone — nothing to signal.
    }
  }
}

function ensureExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const proc of liveServers) signalGroup(proc, 'SIGKILL')
  })
}

/**
 * Stop a spawned server: SIGTERM the group, escalate to SIGKILL if it hasn't
 * exited within `graceMs`, and resolve once it's gone (or a hard deadline
 * passes) so callers can await a genuinely clean shutdown.
 */
function terminateServer(proc: ChildProcessWithoutNullStreams, graceMs = 2_000): Promise<void> {
  if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) {
    liveServers.delete(proc)
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(forceTimer)
      clearTimeout(deadline)
      liveServers.delete(proc)
      resolve()
    }
    const forceTimer = setTimeout(() => signalGroup(proc, 'SIGKILL'), graceMs)
    const deadline = setTimeout(finish, graceMs + 2_000)
    proc.once('exit', finish)
    signalGroup(proc, 'SIGTERM')
  })
}

// Reads ORCHESTRATOR_BASE_URL / ORCHESTRATOR_API_KEY out of reconix.env for the
// provider health probe below. We parse it ourselves — resolving ${VAR} and
// $VAR — rather than Node's loadEnvFile, which SIGTRAPs (uncatchable) on this
// file's `export` + shell interpolation syntax; see index.ts's header comment.
// Best-effort: missing file or keys yield nulls and the probe becomes a no-op.
function readOrchestratorEndpoint(): { baseUrl: string | null; apiKey: string | null } {
  try {
    const text = readFileSync(join(app.getAppPath(), 'reconix.env'), 'utf8')
    const vars: Record<string, string> = {}
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const match = line.replace(/^export\s+/, '').match(/^([A-Za-z0-9_]+)=(.*)$/)
      if (!match) continue
      const value = match[2]
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/\$\{([A-Za-z0-9_]+)\}|\$([A-Za-z0-9_]+)/g, (_, braced, bare) => vars[braced || bare] ?? '')
      vars[match[1]] = value
    }
    return { baseUrl: vars.ORCHESTRATOR_BASE_URL || null, apiKey: vars.ORCHESTRATOR_API_KEY || null }
  } catch {
    return { baseUrl: null, apiKey: null }
  }
}

export interface CopilotBridge {
  /** Keeps the MCP tool server's CDP driver + scope pointed at the tab the
   *  user is actually looking at. Call on every active-tab change. */
  setActiveTarget(wc: WebContents | null, tabId: number | null): void
  /** Resolves once `opencode serve` + the MCP tool server are both up (or
   *  settles with ok:false if that failed) — never throws. Callers that
   *  gate on this (tabs.ts's navigate handler) should still let the user
   *  proceed on ok:false rather than block forever on a dead engine. */
  waitUntilReady(): Promise<{ ok: boolean; error?: string }>
  /** Cost/latency figures for the agentic pipeline (counts + timing only). */
  usageSnapshot(): UsageSnapshot
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

  /** Browser-owned metadata stays available even if the target renderer is
   * busy. Preparing a chat must not wait on Runtime.evaluate in that page. */
  pageContext(): { url: string; title: string } | null {
    if (!this.current || this.current.isDestroyed()) return null
    return { url: this.current.getURL(), title: this.current.getTitle() }
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
  setEmulation(opts: EmulationOptions): Promise<void> {
    return this.require().setEmulation(opts)
  }
  sendRequest(spec: HttpRequestSpec): Promise<HttpReplayResult> {
    return this.require().sendRequest(spec)
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

  constructor(private readonly getCurrentUrl?: () => string | null) {}

  setActiveHost(host: string | null): void {
    this.host = host
  }

  private checker(): ScopeChecker {
    let currentHost = this.host
    try {
      const currentUrl = this.getCurrentUrl?.()
      if (currentUrl) currentHost = new URL(currentUrl).hostname || null
    } catch {
      currentHost = null
    }
    // A local target can be addressed through either loopback spelling. The
    // browser may display `localhost` while captured requests use
    // `127.0.0.1` (or vice versa); both names refer to the same authorized
    // CVE-Bench site and must share the active-tab scope.
    const hosts = currentHost
      ? [currentHost, `*.${currentHost}`, ...(currentHost === 'localhost' ? ['127.0.0.1'] : []), ...(currentHost === '127.0.0.1' ? ['localhost'] : [])]
      : []
    return new ScopeChecker({
      allowed_hosts: hosts,
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

// Fires a single prompt at a named agent (dom-analyzer) and returns its final text,
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
      // Only real web pages are worth summarizing. A blank/new tab (about:blank)
      // or a browser-internal page has no DOM to parse and would just burn a
      // parser call — the navigation that follows will schedule its own run.
      if (!/^https?:/i.test(info.url)) return
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
        // Expected during navigation, not a failure — info-level, not an error.
        console.info(
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

// maxReplayBatch caps how many variants one reconix_replay_batch call may sweep.
// Raise it for bigger fuzz runs; the per-item scope check and the proxy rate
// limit still apply to every request in the batch.
const POLICY: Policy = {
  autoApprove: ['R', 'P'],
  redactCookies: true,
  maxToolCallsPerTurn: 100,
  maxReplayBatch: 20
}

// Ceiling on the per-page DOM summary injected into every orchestrator message.
// ~4k chars ≈ ~1k tokens — enough to be useful on the 20480-token window
// without crowding out the conversation. Detail is on demand via get_dom_extract.
const DOM_SUMMARY_MAX_CHARS = 4000

// Repo-root AGENTS.md, read at most once per process and delivered to the
// orchestrator through buildContextPrefix() (NOT through OpenCode's global
// `instructions`, which would leak Reconix's project guidance into every
// OpenCode session the user runs anywhere). `null` = not read yet; `''` = no
// usable file at the repo root, cached so the per-message path never re-stats.
let cachedAgentsMd: string | null = null

/** The engagement's AGENTS.md content, or '' when there isn't one. Sync read of
 *  one small local file, cached after the first call; never throws. */
function readAgentsMd(): string {
  if (cachedAgentsMd !== null) return cachedAgentsMd
  try {
    cachedAgentsMd = readFileSync(join(app.getAppPath(), 'AGENTS.md'), 'utf8')
  } catch (err) {
    // A missing file is the normal case — only warn on the unexpected.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[copilot] AGENTS.md unreadable; skipping engagement instructions:', err)
    }
    cachedAgentsMd = ''
  }
  return cachedAgentsMd
}

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
 *  versioned source of truth — this is a one-way sync, never the reverse.
 *
 *  The global config is MERGED, not overwritten: Reconix's keys win, but keys
 *  the user set that Reconix doesn't manage (notably `plugins`) are preserved.
 *  A wholesale overwrite silently disabled the user's personal plugins — e.g.
 *  dropping oh-my-opencode-slim removed its `orchestrator` agent from the UI
 *  with no error and nothing pointing at Reconix as the cause. */
async function syncGlobalOpenCodeConfig(): Promise<void> {
  const repoRoot = app.getAppPath()
  const globalDir = openCodeGlobalConfigDir()

  const repoConfig = JSON.parse(await readFile(join(repoRoot, 'opencode.json'), 'utf8')) as JsonObject
  const globalConfigPath = join(globalDir, 'opencode.json')
  let existingConfig: JsonObject | undefined
  try {
    existingConfig = JSON.parse(await readFile(globalConfigPath, 'utf8')) as JsonObject
  } catch {
    // No existing global config (or it isn't valid JSON) — write the repo
    // config as-is rather than failing startup on a malformed user file.
    existingConfig = undefined
  }
  // NOTE: AGENTS.md is deliberately NOT injected into `instructions` here.
  // `instructions` lands in the USER'S global OpenCode config, i.e. it would
  // apply to every OpenCode session they run anywhere, not just Reconix's. The
  // project guidance is instead delivered per-session through
  // buildContextPrefix() below, which scopes it to this app's orchestrator.
  await writeFile(globalConfigPath, `${JSON.stringify(mergeConfig(repoConfig, existingConfig), null, 2)}\n`)

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

/** Owner session of a raw event, for the §6.4 raw-event audit log. The
 *  connector's own `sessionId` is private (reading it would mean editing the
 *  connector, out of scope here), so read the id the event already carries —
 *  data.sessionID for streaming deltas, durable.aggregateID otherwise, the same
 *  fields connector.ts:194-199 keys on. Returns null when the event is
 *  unlabelled. */
function rawEventSessionId(raw: RawEvent): string | null {
  const data = raw.data as Record<string, unknown> | undefined
  const durable = raw.durable as Record<string, unknown> | undefined
  const fromData = typeof data?.sessionID === 'string' && data.sessionID.length > 0 ? data.sessionID : null
  const fromDurable =
    typeof durable?.aggregateID === 'string' && durable.aggregateID.length > 0 ? durable.aggregateID : null
  return fromData ?? fromDurable
}

/** High-volume streaming events that are reconstructable from the durable
 *  turn/message rows (and from the renderer transcript). They arrive per
 *  token, so persisting them would turn every model delta into a SQLite write;
 *  the audit log keeps the durable events and skips these. */
const TRANSIENT_DELTA_EVENT_TYPES = new Set(['session.text.delta', 'session.reasoning.delta'])

export function createCopilotBridge(win: BrowserWindow, getNetwork: () => NetworkCapture | undefined, getInterceptor?: () => { save(raw: unknown): InterceptRule | null; list(): InterceptRule[]; toggle(id: unknown, enabled: unknown): InterceptRule | null; remove(id: unknown): boolean } | undefined, getCrawler?: () => { start(raw: unknown): unknown; stop(): unknown; getState(): unknown } | undefined, getRepeater?: () => { list(): unknown; save(raw: unknown): unknown; remove(id: unknown): unknown; run(id: unknown): unknown; diff(raw: unknown): unknown } | undefined): CopilotBridge {
  setQuestionSender((payload) => { if (!win.isDestroyed()) win.webContents.send('copilot:question', payload) })
  let child: ChildProcessWithoutNullStreams | null = null
  let connector: OpenCodeConnector | null = null
  let starting: Promise<OpenCodeConnector> | null = null
  let mcpServer: McpHttpServer | null = null
  let mcpStarting: Promise<McpHttpServer> | null = null
  let capabilityServer: ReturnType<typeof buildMcpServer> | null = null
  const toolAccessPath = join(app.getPath('userData'), 'copilot-tool-access.json')
  // User-authored engagement restrictions (markdown). Injected into the
  // orchestrator once per session (see restrictionsInjected below).
  const restrictionsPath = join(app.getPath('userData'), 'restrictions.md')
  // False until the current orchestrator session has been handed the
  // restrictions block. Reset on a fresh session, a new chat, and whenever
  // the user edits the file, so the next message re-injects the rules once.
  let restrictionsInjected = false
  const readRestrictions = async (): Promise<string> => {
    try {
      return (await readFile(restrictionsPath, 'utf8')).trim()
    } catch {
      return '' // no file yet — nothing to inject
    }
  }

  const cdp = new ActiveTabCdpDriver((wc) => wc.id === win.webContents.id)
  const scope = new ActiveTabScope(() => cdp.pageContext()?.url ?? null)
  const networkReader = new ActiveTabNetworkReader(getNetwork)
  // The §6.4 engagement store: one SQLite DB shared by findings, traces, and the
  // tool-call audit log, so everything survives a restart. The engagement id is
  // the real scope.json id (or null when none is loaded) — the same value the
  // tool context and audit log attribute rows to, so nothing diverges.
  const db = openDatabase(join(app.getPath('userData'), 'reconix.db'))
  // The engagement store owns the run lifecycle + the engagement:* IPC. Its
  // currentId() feeds attribution (findings/traces/tool_calls/ctx), so a
  // started run's rows are attributed consistently without rewiring per call.
  const engagementStore = createEngagementStore(db, win, { defaultPolicy: POLICY })
  const getEngagementId = (): string | null => engagementStore.currentId()
  const findingsStore = createFindingsStore(db, win, { getEngagementId })
  // Trace bytes live as files on disk (§6.4); the DB keeps only ref + path.
  const traces = createTraceStore(db, win, {
    getEngagementId,
    tracesDir: join(app.getPath('userData'), 'traces')
  })
  const history = createHistoryReader(db, findingsStore)
  // The audit logger is created here (not per-MCP-server) so the approval relay
  // — which runs outside the tool pipeline — can persist sign-offs to the same
  // append-only store (§6.4: tool_calls + approvals are the point of the store).
  const audit = createAuditLogger(db)

  // Raw-event audit log (§6.4, TODO B): the connector's persist sink appends
  // every observed event here verbatim. Continue the `re_<n>` sequence past any
  // rows already on disk so a restart never reuses a PRIMARY KEY.
  let rawEventSeq = 0
  for (const row of db.all('SELECT id FROM raw_events')) {
    const match = /^re_(\d+)$/.exec(String((row as Record<string, unknown>).id))
    if (match) rawEventSeq = Math.max(rawEventSeq, Number(match[1]))
  }
  // getEngagementId() hits engagementStore.currentId() → the DB, and the persist
  // sink fires many times per turn. Resolve it at most once per turn: undefined
  // means "not resolved yet", null is a real answer (no engagement loaded). The
  // cache is dropped on turn end and on every new session, since a run can start
  // or stop between turns.
  let cachedEngagementId: string | null | undefined
  const rawEventEngagementId = (): string | null => {
    if (cachedEngagementId === undefined) cachedEngagementId = getEngagementId()
    return cachedEngagementId
  }
  // Rate-limits the raw-event write failure warning to one line per burst: the
  // streaming loop retries on the next event, so a broken store would otherwise
  // log on every token. Cleared by the next successful write.
  let rawEventWriteFailing = false

  // Cost/latency meter. Fed by the connector's persist (all sessions, incl.
  // subagents + the ambient DOM parser) and onAgentEvent (orchestrator turn
  // timeline) sinks below, plus explicit notes at the send/parser call sites.
  const usage = new UsageMeter({
    modelForRole: (role) =>
      role === 'orchestrator'
        ? ORCHESTRATOR_MODEL
        : role === 'dom-analyzer' || role === 'subagent'
          ? DOM_ANALYZER_MODEL
          : 'unknown'
  })

  // Ambient state, prepended to every message sent to the orchestrator so it
  // doesn't have to spend a tool call just to re-orient itself each turn
  // (what page, what origin). Never shown in the renderer's own transcript —
  // the user bubble there is the raw typed text (useCopilot.ts), this prefix
  // only goes to OpenCode.
  function buildContextPrefix(): string {
    // Project guidance (AGENTS.md) rides along as a labelled block instead of
    // OpenCode's global `instructions`, so it only reaches THIS engagement's
    // orchestrator. Read once and cached by readAgentsMd().
    const instructions = readAgentsMd().trim()
    const agentsBlock = instructions
      ? `[Engagement instructions (AGENTS.md) — project guidance for this engagement, not written by the user:]\n${instructions}`
      : ''
    try {
      const info = cdp.pageContext()
      if (!info) return agentsBlock ? `${agentsBlock}\n\n` : ''
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
        `title: ${JSON.stringify(info.title)} | ` +
        `${recent} network request(s) captured for this tab (get_network_log for detail)]`
      // Cap the injected summary: it rides on EVERY message to the small-window
      // orchestrator, so an over-long parser summary would crowd out the
      // conversation and push the turn toward a context-overflow failure.
      const rawSummary = domWatcher.summaryFor(info.url)
      const domSummary =
        rawSummary && rawSummary.length > DOM_SUMMARY_MAX_CHARS
          ? `${rawSummary.slice(0, DOM_SUMMARY_MAX_CHARS)}\n…[summary truncated to fit context; use get_dom_extract / eval_in_page for specifics]`
          : rawSummary
      const domBlock = domSummary
        ? `\n\n[DOM summary from @parser, auto-refreshed on navigation — not written by the user:]\n${domSummary}`
        : '\n\n[@parser hasn\'t produced a DOM summary for this page yet — call eval_in_page yourself if you need structure right now.]'
      return `${header}${domBlock}${agentsBlock ? `\n\n${agentsBlock}` : ''}\n\n`
    } catch {
      // No active tab yet — don't block the message on page state, but the
      // engagement instructions are still worth sending.
      return agentsBlock ? `${agentsBlock}\n\n` : ''
    }
  }

  const send = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }

  // Usage/latency push. Turn updates arrive in bursts (a delta per token, a
  // rollup per tool), so coalesce them to ~2Hz; `immediate` flushes at
  // boundaries where the UI should react at once (send, turn end, parser done).
  let usageTimer: ReturnType<typeof setTimeout> | null = null
  let usageDirty = false
  const emitUsage = (immediate = false): void => {
    if (immediate) {
      if (usageTimer) {
        clearTimeout(usageTimer)
        usageTimer = null
      }
      usageDirty = false
      send('copilot:usage', usage.snapshot())
      return
    }
    usageDirty = true
    if (usageTimer) return
    usageTimer = setTimeout(() => {
      usageTimer = null
      if (!usageDirty) return
      usageDirty = false
      send('copilot:usage', usage.snapshot())
    }, 500)
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
        stdio: 'pipe',
        // Own process group so we can tear down serve AND anything it forks
        // (see signalGroup); without this a clean quit can leave it dangling.
        detached: process.platform !== 'win32'
      })
      child = proc
      liveServers.add(proc)
      ensureExitHook()
      proc.on('exit', () => liveServers.delete(proc))
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
      const context: ToolContext = {
        get engagementId() {
          return engagementStore.currentId()
        },
        scope,
        policy: POLICY,
        cdp,
        network: networkReader,
        traces: traces.store,
        findings: findingsStore.sink,
        history,
        interceptor: getInterceptor?.(),
        crawler: getCrawler?.(),
        repeater: getRepeater?.()
      }
      const registry = buildMcpServer({ audit, context, surface: 'all' })
      try {
        const saved = JSON.parse(await readFile(toolAccessPath, 'utf8'))
        const knownNow = registry.getToolAccess().map((t) => t.name)
        let enabled: string[] | null = null
        if (Array.isArray(saved) && saved.every((name) => typeof name === 'string')) {
          // Legacy format: a bare list of enabled names with no record of what
          // existed when it was written, so we can't distinguish a deliberate
          // disable from a newly added tool. Err toward availability and enable
          // the full catalog once; the next save writes the richer format below.
          enabled = knownNow
        } else if (saved && Array.isArray(saved.enabled) && Array.isArray(saved.known)) {
          const knownSet = new Set<string>(knownNow)
          const previouslyKnown = new Set<string>(saved.known.filter((n: unknown) => typeof n === 'string'))
          const savedEnabled = new Set<string>(saved.enabled.filter((n: unknown) => typeof n === 'string'))
          enabled = [...knownSet].filter((name) => savedEnabled.has(name) || !previouslyKnown.has(name))
        }
        if (enabled) registry.setEnabledTools(enabled)
      } catch {
        // First launch or an invalid preference file: preserve the existing
        // behavior by enabling the full catalog.
      }
      capabilityServer = registry
      let s: McpHttpServer
      try {
        s = await startMcpHttpServer(registry, { port: MCP_PORT })
      } catch (err) {
        // During Electron restarts the previous bridge can briefly retain the
        // listener even though this bridge is the one that owns the process.
        // OpenCode can continue using that already-live MCP endpoint; do not
        // fail the entire Copilot engine just because the bind is idempotent.
        if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw err
        s = {
          port: MCP_PORT,
          url: `http://127.0.0.1:${MCP_PORT}/mcp`,
          async stop() {}
        }
      }
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
    // Dedupe: the periodic provider probe below calls this on every tick, and
    // re-pushing an unchanged status would churn IPC + renderer state for no
    // reason. Compare status AND error so a changed error message still pushes.
    const prevError = 'error' in engineStatus ? engineStatus.error : undefined
    const nextError = 'error' in next ? next.error : undefined
    if (next.status === engineStatus.status && nextError === prevError) return
    engineStatus = next
    send('copilot:engine-status', next)
  }

  // ─── Model-backend liveness ────────────────────────────────────────────────
  // engineReady (below) only tells us the LOCAL engine booted. The orchestrator
  // model runs on a remote vLLM server (reconix.env) that can die independently;
  // when it does, turns fail but the engine was still advertising "ready". We
  // probe that provider directly and reflect it in the same EngineStatus, so the
  // UI flips ready <-> offline honestly instead of latching on "ready" forever.
  const orchestrator = readOrchestratorEndpoint()
  let probing = false
  let providerProbeTimer: ReturnType<typeof setInterval> | null = null

  // true = reachable, false = down, null = not configured (nothing to probe).
  async function probeProvider(): Promise<boolean | null> {
    if (!orchestrator.baseUrl) return null
    const url = orchestrator.baseUrl.replace(/\/+$/, '') + '/models'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    try {
      // Any HTTP reply (even 401/404) proves the server is listening; only a
      // network error or timeout counts as down.
      await fetch(url, {
        signal: controller.signal,
        headers: orchestrator.apiKey ? { Authorization: `Bearer ${orchestrator.apiKey}` } : {}
      })
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  // Reflects the probe into EngineStatus, governing ONLY the ready <-> offline
  // pair — it never overrides the one-time boot states ('starting' / boot
  // 'error'), and bails if the endpoint isn't configured.
  // A function call (not an inline check) so TS doesn't carry the narrowing
  // across the await below — engineStatus can change while the probe runs.
  function inBootState(): boolean {
    return engineStatus.status === 'starting' || engineStatus.status === 'error'
  }

  async function refreshProviderHealth(): Promise<void> {
    if (probing) return
    if (inBootState()) return
    probing = true
    try {
      const ok = await probeProvider()
      if (ok === null) return
      if (inBootState()) return
      setEngineStatus(ok ? { status: 'ready' } : { status: 'offline', error: 'Model backend unreachable' })
    } finally {
      probing = false
    }
  }

  setEngineStatus({ status: 'starting' })
  const engineReady: Promise<{ ok: boolean; error?: string }> = ensureServerInfo().then(
    () => {
      // Warm the session/event stream before the first prompt, but do not make
      // browser navigation wait on OpenCode's session/health endpoints.
      void ensureConnector().catch((err: unknown) => {
        console.error('[copilot] session warm-up failed:', err)
      })
      setEngineStatus({ status: 'ready' })
      // Now that the local engine is up, start watching the model backend:
      // one immediate check (so a backend that's already down shows 'offline'
      // right away) plus a steady poll that keeps the indicator honest.
      void refreshProviderHealth()
      if (!providerProbeTimer) {
        providerProbeTimer = setInterval(() => void refreshProviderHealth(), PROVIDER_PROBE_INTERVAL_MS)
      }
      return { ok: true }
    },
    (err: unknown) => {
      const error = err instanceof Error ? err.message : String(err)
      console.error('[copilot] engine warm-up failed:', err)
      setEngineStatus({ status: 'error', error })
      return { ok: false, error }
    }
  )

  // Main can be recreated during development reloads. Replace our own handlers
  // explicitly so a stale registration can neither win nor prevent startup.
  ipcMain.removeHandler('copilot:get-engine-status')
  ipcMain.handle('copilot:get-engine-status', () => engineStatus)
  ipcMain.removeHandler('copilot:get-tool-access')
  ipcMain.handle('copilot:get-tool-access', async () => {
    await ensureMcpServer()
    return capabilityServer?.getToolAccess() ?? []
  })
  ipcMain.removeHandler('copilot:set-enabled-tools')
  ipcMain.handle('copilot:set-enabled-tools', async (_event, names: unknown) => {
    await ensureMcpServer()
    if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) {
      throw new Error('Enabled function names must be an array of strings')
    }
    const access = capabilityServer?.setEnabledTools(names) ?? []
    // Persist enabled names AND the full known set, so a later launch can tell
    // a deliberate disable apart from a tool that didn't exist yet.
    await writeFile(
      toolAccessPath,
      JSON.stringify({
        enabled: access.filter((tool) => tool.enabled).map((tool) => tool.name),
        known: access.map((tool) => tool.name)
      })
    )
    return access
  })

  const domWatcher = new DomSummaryWatcher(
    () => cdp,
    async (html) => {
      const { baseUrl, password } = await ensureServerInfo().catch(() => ({ baseUrl: '', password: '' }))
      if (!baseUrl) return null
      const started = Date.now()
      try {
        return await runOneShotAgent(baseUrl, password, 'dom-analyzer', html)
      } finally {
        usage.noteAmbientCall('dom-analyzer', Date.now() - started)
        emitUsage(true)
      }
    }
  )

  // Only timing metadata is logged, never prompts, target data or credentials.
  let responseStartedAt: number | null = null
  let firstOutputSeen = false

  async function ensureConnector(): Promise<OpenCodeConnector> {
    if (connector) return connector
    if (starting) return starting
    starting = (async () => {
      const { baseUrl, password } = await ensureServerInfo()
      const c = createOpenCodeConnector(
        { baseUrl, password, agent: 'pentest-orchestrator', model: ORCHESTRATOR_MODEL, requiredMcpServer: 'reconix' },
        {
          onAgentEvent: (ev: AgentEvent) => {
            if (responseStartedAt !== null) {
              const elapsedMs = Math.round(performance.now() - responseStartedAt)
              if (!firstOutputSeen && (ev.kind === 'message.delta' || ev.kind === 'reasoning.delta' || ev.kind === 'tool.call')) {
                firstOutputSeen = true
                console.info('[copilot:latency]', { phase: 'first-output', kind: ev.kind, elapsedMs })
              }
              if (ev.kind === 'turn.done' || ev.kind === 'error') {
                console.info('[copilot:latency]', { phase: 'turn-finished', elapsedMs })
                responseStartedAt = null
              }
            }
            // A turn boundary is when a run can start or stop, so drop the cached
            // engagement id here (outside the latency guard: subagent/ambient
            // turns end without a responseStartedAt window too).
            if (ev.kind === 'turn.done' || ev.kind === 'error') cachedEngagementId = undefined
            usage.recordAgentEvent(ev)
            emitUsage(ev.kind === 'turn.done' || ev.kind === 'error')
            send('copilot:event', ev)
            // Fail-flip: a turn erroring out is the first sign the model backend
            // may have dropped. Probe immediately rather than waiting for the
            // next poll — the probe is the arbiter, so a non-connectivity error
            // (e.g. a tool failure) simply confirms 'ready' and nothing changes.
            if (ev.kind === 'error') void refreshProviderHealth()
          },
          persist: (raw: RawEvent, _normalized: AgentEvent | null) => {
            usage.recordRaw(raw)
            emitUsage()
            // Streaming deltas are reconstructable from the durable turn rows and
            // arrive per token; persisting them would mean one SQLite write per
            // delta for no audit value. Metering above still sees them.
            if (TRANSIENT_DELTA_EVENT_TYPES.has(raw.type)) return
            // Write-through to the §6.4 store: append the raw event verbatim so
            // the stream has a durable audit record. Best-effort and non-fatal —
            // a store failure must never re-enter or stall the streaming loop
            // that owns this callback, so it's swallowed, not thrown.
            try {
              db.run(
                'INSERT INTO raw_events (id, engagement_id, session_id, type, data_json, ts) VALUES (?, ?, ?, ?, ?, ?)',
                [`re_${++rawEventSeq}`, rawEventEngagementId(), rawEventSessionId(raw), raw.type, JSON.stringify(raw), Date.now()]
              )
              rawEventWriteFailing = false // burst over — warn again if it recurs
            } catch (err) {
              if (!rawEventWriteFailing) {
                rawEventWriteFailing = true
                console.warn('[copilot:persist] raw event dropped (further drops until the next successful write are not logged)', err)
              }
            }
          },
          onStatus: (status: ServerStatus) => send('copilot:status', status)
        }
      )
      const sessionId = await c.start()
      restrictionsInjected = false // fresh session — re-send restrictions on next message
      cachedEngagementId = undefined // fresh session — re-resolve attribution lazily
      usage.registerSession(sessionId, 'orchestrator')
      connector = c
      return c
    })()
    try {
      return await starting
    } finally {
      starting = null
    }
  }

  ipcMain.removeHandler('copilot:send')
  ipcMain.handle('copilot:send', async (_event, text: string) => {
    responseStartedAt = performance.now()
    firstOutputSeen = false
    try {
      const c = await ensureConnector()
      const prefix = buildContextPrefix()
      // Hand the agent the user's engagement restrictions once per session,
      // ahead of everything else, so it knows the rules before it acts.
      let restrictionsBlock = ''
      if (!restrictionsInjected) {
        const restrictions = await readRestrictions()
        if (restrictions) {
          restrictionsBlock =
            '[Engagement restrictions — user-authored rules you MUST obey for the entire ' +
            'session. These take precedence over task instructions. If a requested action ' +
            'would violate them, refuse and say why:]\n' +
            restrictions +
            '\n\n'
        }
        restrictionsInjected = true // empty file counts as handled — don't retry every turn
      }
      usage.noteSend()
      emitUsage(true)
      return await c.sendMessage(restrictionsBlock + prefix + String(text))
    } catch (err) {
      responseStartedAt = null
      throw err
    }
  })

  ipcMain.removeHandler('copilot:new-chat')
  ipcMain.handle('copilot:new-chat', async () => {
    const c = await ensureConnector()
    const id = await c.newSession()
    restrictionsInjected = false // new chat is a new session — restrictions re-inject
    cachedEngagementId = undefined // new session — attribution re-resolved lazily
    usage.registerSession(id, 'orchestrator')
    return id
  })

  ipcMain.removeHandler('copilot:respond-question')
  ipcMain.handle('copilot:respond-question', async (_event, questionId: string, answer: unknown) => {
    const { resolveQuestion } = await import('./questionBridge')
    resolveQuestion(String(questionId), (answer as string | string[] | null) ?? null)
  })

  ipcMain.removeHandler('copilot:respond-approval')
  ipcMain.handle('copilot:respond-approval', async (_event, approvalId: string, decision: ApprovalDecision) => {
    const c = await ensureConnector()
    await c.respondApproval(String(approvalId), decision)
    // Persist the human sign-off (§6.4 approvals, append-only). Best-effort: an
    // audit write must never break the approval relay. The app has no auth yet,
    // so the actor is the acting operator.
    void audit
      .recordApproval({ approvalId: String(approvalId), decision, actor: 'operator' })
      .catch(() => undefined)
  })

  ipcMain.removeHandler('copilot:interrupt')
  ipcMain.handle('copilot:interrupt', async () => {
    const c = await ensureConnector()
    return c.interrupt()
  })

  ipcMain.removeHandler('copilot:get-restrictions')
  ipcMain.handle('copilot:get-restrictions', () => readRestrictions())
  ipcMain.removeHandler('copilot:set-restrictions')
  ipcMain.handle('copilot:set-restrictions', async (_event, text: unknown) => {
    if (typeof text !== 'string') throw new Error('Restrictions must be a string')
    const trimmed = text.trim()
    await writeFile(restrictionsPath, trimmed)
    restrictionsInjected = false // an edit re-injects the rules on the next message
    return trimmed
  })

  ipcMain.removeHandler('copilot:usage-snapshot')
  ipcMain.handle('copilot:usage-snapshot', () => usage.snapshot())

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
    usageSnapshot() {
      return usage.snapshot()
    },
    async stop() {
      ipcMain.removeHandler('copilot:send')
      ipcMain.removeHandler('copilot:new-chat')
      ipcMain.removeHandler('copilot:respond-approval')
      ipcMain.removeHandler('copilot:interrupt')
      ipcMain.removeHandler('copilot:get-engine-status')
      ipcMain.removeHandler('copilot:get-tool-access')
      ipcMain.removeHandler('copilot:set-enabled-tools')
      ipcMain.removeHandler('copilot:usage-snapshot')
      ipcMain.removeHandler('copilot:get-restrictions')
      ipcMain.removeHandler('copilot:set-restrictions')
      if (usageTimer) {
        clearTimeout(usageTimer)
        usageTimer = null
      }
      if (providerProbeTimer) {
        clearInterval(providerProbeTimer)
        providerProbeTimer = null
      }
      domWatcher.setActive(null)
      findingsStore.close()
      traces.close()
      await connector?.stop().catch(() => undefined)
      await mcpServer?.stop().catch(() => undefined)
      // The stores' close() only detach IPC; the shared DB is ours to close.
      if (db.isOpen) db.close()
      const proc = child
      child = null
      if (proc) await terminateServer(proc)
    }
  }
}

// Guarded smoke harness — runs ONLY when RECONIX_SMOKE=1. Exercises the MCP
// pipeline + CDP driver + OpenCode connector inside the real Electron main
// process, prints a PASS/FAIL report, and quits. Not part of normal startup.

import { app, WebContentsView } from 'electron'
import type { AgentEvent, Policy, ScopeConfig } from '../shared/contracts'
import { buildMcpServer } from './mcp'
import { InMemoryAuditLogger } from './mcp/audit'
import { ScopeChecker } from './mcp/scope'
import { WebContentsCdpDriver } from './mcp/cdp'
import type { ToolContext } from './mcp/tool'
import { OpenCodeConnector } from './opencode/connector'
import type { OpenCodeTransport, RawEvent } from './opencode/transport'

const results: { name: string; ok: boolean; detail: string }[] = []
function check(name: string, ok: boolean, detail: unknown): void {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail)
  results.push({ name, ok, detail: d })
  // Print immediately so partial progress survives a hard exit.
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}  — ${d}`)
}
function step(label: string): void {
  console.log(`   … ${label}`)
}

const SCOPE: ScopeConfig = {
  allowed_hosts: ['example.com', '*.example.com'],
  allowed_cidrs: [],
  denied: ['evil.invalid'],
  rate_limits: {}
}
const POLICY: Policy = { autoApprove: ['R', 'P'], redactCookies: true, maxToolCallsPerTurn: 100 }

function buildServer(wc: Electron.WebContents, audit: InMemoryAuditLogger): ReturnType<typeof buildMcpServer> {
  const ctx: ToolContext = {
    engagementId: 'eng_smoke',
    scope: new ScopeChecker(SCOPE),
    policy: POLICY,
    cdp: new WebContentsCdpDriver(wc, () => false /* not the UI */),
    traces: { save: async () => 'trace_mock' },
    findings: { record: async () => 'find_mock' },
    history: { query: async () => [] }
  }
  return buildMcpServer({ audit, context: ctx, surface: 'all' })
}

// Checks that need NO real page — the pipeline enforcement + pure-compute tools.
async function runPipelineChecks(audit: InMemoryAuditLogger): Promise<void> {
  const view = new WebContentsView({ webPreferences: { sandbox: true } })
  const server = buildServer(view.webContents, audit)

  check('listTools advertises catalog', server.listTools().length >= 15, `${server.listTools().length} tools`)

  const denied = await server.callTool('navigate', { url: 'http://evil.invalid/' })
  check('navigate out-of-scope denied', !denied.ok && denied.error?.code === 'OUT_OF_SCOPE', denied.error)

  const bad = await server.callTool('navigate', { url: 'ftp://nope' })
  check('malformed url rejected', !bad.ok && bad.error?.code === 'TOOL_INPUT', bad.error)

  const unknown = await server.callTool('exec_shell', { cmd: 'id' })
  check('unknown tool hard-rejected', !unknown.ok && unknown.error?.code === 'UNKNOWN_TOOL', unknown.error)

  const fuzz = await server.callTool('gen_fuzz_payloads', { encodings: ['url', 'base64'], boundaries: true })
  check('gen_fuzz_payloads', fuzz.ok && (fuzz.output as { payloads: string[] }).payloads.length > 10, `${(fuzz.output as { payloads: string[] })?.payloads?.length} payloads`)

  const redos = await server.callTool('break_regex', { pattern: '(a+)+$' })
  check('break_regex detects nested quantifier', redos.ok && /catastrophic/.test((redos.output as { notes: string }).notes), (redos.output as { notes: string })?.notes)

  check('audit recorded intents', audit.intents.size >= 4, `${audit.intents.size} intents, ${audit.outcomes.size} outcomes`)
  view.webContents.close()
}

// The CDP-dependent check, isolated and run last so a native issue here can't
// swallow the rest of the report.
async function runCdpCheck(): Promise<void> {
  try {
    step('creating target WebContentsView')
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'smoke' }
    })
    const wc = view.webContents
    step('loading data: page')
    await wc.loadURL('data:text/html,<title>Smoke</title><h1 id=x>hi</h1>')
    step('eval_in_page over CDP')
    const server = buildServer(wc, new InMemoryAuditLogger())
    const evalRes = await server.callTool('eval_in_page', { expression: 'document.title' })
    check('eval_in_page via CDP', evalRes.ok && (evalRes.output as { resultText: string }).resultText === '"Smoke"', evalRes)
    wc.close()
  } catch (err) {
    check('eval_in_page via CDP', false, String(err))
  }
}

// Mock OpenCode transport: emits a canned SSE sequence, captures the reply.
class MockTransport implements OpenCodeTransport {
  replied: { pid: string; decision: string } | null = null
  async health(): Promise<boolean> { return true }
  async createSession(): Promise<{ id: string }> { return { id: 'sess_1' } }
  async sendMessage(): Promise<{ messageId: string }> { return { messageId: 'm1' } }
  async respondPermission(_s: string, pid: string, decision: string): Promise<void> {
    this.replied = { pid, decision }
  }
  async abort(): Promise<void> {}
  // Real frame shape, confirmed live against `opencode serve` (API.md §2.1):
  // flat { type, data }, permission events un-namespaced ("permission.asked",
  // not "session.permission.asked"). See normalize.ts's header comment.
  async *subscribe(): AsyncIterable<RawEvent> {
    yield { type: 'session.text.delta', data: { assistantMessageID: 'm1', delta: 'hello' } }
    yield { type: 'permission.asked', data: { id: 'perm_9', action: 'navigate', resources: ['example.com'] } }
    yield { type: 'session.execution.succeeded', data: { sessionID: 'sess_1' } }
  }
}

async function runConnector(): Promise<void> {
  const seen: AgentEvent[] = []
  const transport = new MockTransport()
  const connector = new OpenCodeConnector(transport, {
    onAgentEvent: (ev) => seen.push(ev),
    persist: () => {},
    onStatus: () => {}
  })
  await connector.start()
  await new Promise((r) => setTimeout(r, 150)) // let the stream drain

  check('connector normalizes message delta', seen.some((e) => e.kind === 'message.delta'), seen.map((e) => e.kind))
  const approval = seen.find((e) => e.kind === 'approval.request')
  check('connector surfaces approval request', !!approval, approval)

  if (approval && approval.kind === 'approval.request') {
    await connector.respondApproval(approval.approvalId, 'approve')
  }
  check('approval relayed to transport', transport.replied?.pid === 'perm_9' && transport.replied.decision === 'approve', transport.replied)
  await connector.stop()
}

function finish(): void {
  const pass = results.filter((r) => r.ok).length
  console.log(`──────── ${pass}/${results.length} passed ────────\n`)
  app.exit(pass === results.length && results.length > 0 ? 0 : 1)
}

export async function runSmoke(): Promise<void> {
  console.log('\n──────── RECONIX SMOKE (real Electron main) ────────')
  // Watchdog: never let the harness hang the app.
  const watchdog = setTimeout(() => {
    check('harness finished within 10s', false, 'watchdog fired')
    finish()
  }, 10_000)
  try {
    await runConnector()
    await runPipelineChecks(new InMemoryAuditLogger())
    await runCdpCheck()
  } catch (err) {
    check('harness completed without throwing', false, String(err))
  }
  clearTimeout(watchdog)
  finish()
}

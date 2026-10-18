# API.md — Reconix connection & tool spec

Companion to `ARCHITECTURE.MD`. Expands the frozen contracts (6.1 IPC, 6.2 MCP, 6.3 OpenCode events, 6.6 model) into concrete signatures. Where this doc and `ARCHITECTURE.MD` §6 disagree, §6 wins — raise a PR to reconcile.

**Status:** draft. Parts marked 🔒 are ours to define now. Parts marked ⏳ are OpenCode-beta surface and are **pinned during the Phase-0 spine spike** (§6.3) — the shapes here are provisional until then.

---

## 0. The three hops

```
 Renderer (Dev 1)            Main / Orchestration (Dev 2)              OpenCode (Dev 4 container)        Tool server (Dev 3)
 ───────────────             ────────────────────────────             ─────────────────────────        ───────────────────
  window.reconix.*  ──IPC──▶  invoke handlers                ──HTTP──▶ POST session / message
       ◀──events──  webContents.send ◀── SSE normalize ◀──SSE── GET event stream
                            approval relay  ──HTTP──▶ respond permission
                                                          OpenCode ──MCP (stdio/http)──▶ tool handlers ──▶ CDP / compute
                            audit + fan-out ◀───────────────────────────────────────────── write-through (6.4)
```

Three contracts, three owners of the seams: **IPC** (Dev 1↔Dev 2), **OpenCode HTTP/SSE** (Dev 2↔Dev 4), **MCP** (OpenCode↔Dev 3, Dev 1's 5.E tools registered in).

---

## 1. Client ↔ Main — IPC (🔒 expands §6.1)

Transport: `contextBridge` → `window.reconix.*`. Request/response use `ipcRenderer.invoke` (returns a Promise). Events are one-way `webContents.send`, consumed via a preload `on(channel, cb)` that returns an unsubscribe fn. All payloads structured-cloneable (no functions/class instances).

### 1.1 Renderer → Main (invoke)

| Method | Request | Returns | Notes |
|---|---|---|---|
| `startEngagement` | `{ goal: string, scope: ScopeConfig, policy: Policy }` | `{ engagementId: string }` | Spawns/attaches an OpenCode session. Fails if one is live. |
| `sendMessage` | `{ engagementId, text: string }` | `{ messageId: string }` | User turn into the agent session. |
| `respondApproval` | `{ approvalId, decision: "approve" \| "deny" \| "edit", editedParams?: object }` | `{ ok: true }` | Unblocks a gated tool call. `edit` requires `editedParams`. |
| `pause` / `resume` | `{ engagementId }` | `{ state: "paused" \| "running" }` | Global halt — Main stops relaying tool permissions as auto. |
| `stopEngagement` | `{ engagementId }` | `{ ok: true }` | Abort run, close session. |
| `queryHistory` | `{ engagementId, filter: HistoryFilter }` | `{ rows: HistoryRow[] }` | Read-only view of the engagement store (6.4). Display only. |
| `exportReport` | `{ engagementId, format: "md" \| "html" \| "json" }` | `{ path: string }` | Renders findings + evidence refs. |

### 1.2 Main → Renderer (events)

| Channel | Payload | Purpose |
|---|---|---|
| `agent:event` | `AgentEvent` (see 1.3) | the single transcript stream |
| `viewport:state` | `{ engagementId, url, loading, title, scopeState: "in" \| "out" \| "unknown" }` | viewport chrome |
| `server:status` | `{ state: "starting" \| "ready" \| "reconnecting" \| "down", detail?: string }` | connection banner |
| `finding:new` | `Finding` | live report sidebar |

### 1.3 `AgentEvent` — normalized union (🔒 client-facing, ours to define)

Dev 2 normalizes every OpenCode SSE event (1.3 raw shapes ⏳) into exactly these kinds. The renderer switches on `kind` and renders **all `*.text` / `*.body` fields as text nodes only**.

```ts
type AgentEvent =
  | { kind: "message.delta";   messageId: string; role: "assistant"; text: string }
  | { kind: "reasoning.delta"; messageId: string; text: string }
  | { kind: "tool.call";       callId: string; tool: string; params: object; riskTier: "R"|"P"|"M"|"D"; target?: string }
  | { kind: "tool.result";     callId: string; ok: boolean; resultRef?: string; error?: string; output?: string }
  | { kind: "approval.request"; approvalId: string; callId: string; tool: string; params: object; riskTier: "M"|"D"; target?: string }
  | { kind: "approval.resolved"; approvalId: string; decision: "approve"|"deny"|"edit" }
  | { kind: "turn.done";       messageId: string }
  | { kind: "error";           scope: "session"|"tool"|"model"; message: string }
```

`approvalId` (1.1 `respondApproval`) and `callId` (correlates `tool.call`→`tool.result`) are issued by Main. `callId` maps 1:1 to a `tool_calls` row (6.4).

---

## 2. Main ↔ OpenCode — HTTP + SSE (⏳ provisional; pin in spine spike per §6.3)

**Connection.** OpenCode binds `0.0.0.0` inside its container; Dev 4 publishes the port to `127.0.0.1:<hostPort>`. Base URL `http://127.0.0.1:<hostPort>`. Every request carries the spawn-time secret:

```
Authorization: Bearer <OPENCODE_SERVER_PASSWORD>
```

Dev 2 uses `@opencode-ai/sdk` (`createOpencodeClient({ baseUrl, password })`), falling back to `createOpencodeServer` as a launcher. The table below is the **logical** surface B's adapter needs; exact method/path names are confirmed against the pinned SDK in Phase 0 and recorded here.

| Logical op | Provisional HTTP | B's use |
|---|---|---|
| **readiness** | `GET /health` (or SDK `.health()`) | gate before first prompt; drives `server:status` |
| **create session** | `POST /session` → `{ id }` | one session per engagement |
| **send prompt** | `POST /session/:id/message` body `{ parts: [{ type:"text", text }] }` | user turn (1.1 `sendMessage`) |
| **event stream** | `GET /event` (SSE) | the source B normalizes into `agent:event` |
| **respond to permission** | `POST /session/:id/permission/:permId` body `{ decision }` | approval relay (1.1 `respondApproval`) |
| **abort** | `POST /session/:id/abort` | pause / stop |
| **session teardown** | `DELETE /session/:id` | end of engagement |

### 2.1 SSE → `agent:event` normalization (⏳ confirm raw names in spike)

| OpenCode SSE event (provisional) | → `AgentEvent.kind` |
|---|---|
| `message.part.updated` (assistant text) | `message.delta` |
| `message.part.updated` (reasoning) | `reasoning.delta` |
| tool invocation start | `tool.call` |
| tool invocation result | `tool.result` |
| `permission.requested` | `approval.request` |
| `permission.replied` | `approval.resolved` |
| `message.updated` (finished) | `turn.done` |
| `session.error` | `error` |

**Capture-as-you-stream:** for every raw event, B does both forward-to-renderer *and* persist-to-store (6.4) in one pass. Audit is a side effect of the event passing through, never a second call.

### 2.2 Permission round-trip (the core loop)

```
OpenCode emits permission.requested (tool is tier M/D)
  → B persists tool_calls intent row, emits agent:event approval.request
    → Renderer renders inline approve/deny/edit
      → Renderer invoke respondApproval({ approvalId, decision, editedParams? })
        → B writes approvals row (6.4), POST /session/:id/permission/:permId { decision }
          → OpenCode proceeds or cancels the tool call
            → tool.result → agent:event tool.result
```

Tier R/P tools never raise a permission event (OpenCode permission config keys off the tier map from Dev 3). Main is transport + relay only; the human makes the decision.

---

## 3. MCP endpoints — the tool catalog (6.2 + Appendix, with signatures)

Transport: MCP server owned by Dev 3; OpenCode loads it as its **only** tool source (built-ins disabled by Dev 4). Dev 1's 5.E tools register into the same server. Every tool: `{ name, description, inputSchema, outputSchema, riskTier }`; every handler runs `schema-validate → scope-check → execute → audit write-through`. Signatures below are TypeScript shorthand for the JSON Schemas.

Tiers: **R** read-only (auto) · **P** page-mutating, sandbox-only (auto) · **M** mutating (approval) · **D** destructive (approval + rate-limit).

### 3.1 Session & scope — R
```ts
get_scope(): ScopeConfig
get_engagement_state(): { engagementId, url, phase, counts: { findings, toolCalls } }
```

### 3.2 Navigation & page read — R  (navigate is scope-checked)
```ts
navigate({ url: string }): { status: number, finalUrl: string, extract: DomExtract }   // scope-checked
get_page_info(): { url, title, readyState }
get_dom_extract(): DomExtract        // forms/inputs/endpoints/links(in+out scope)/headers/csrfPresence, each with identity
list_forms(): FormRef[]
list_links(): LinkRef[]
get_headers(): Record<string,string>
get_cookies(): CookieRef[]            // values redacted unless policy allows
screenshot({ fullPage?: boolean }): { traceRef: string }
```

### 3.3 Page interaction & CDP page-power — P  (sandbox-only, target view only)
```ts
click({ selector: string }): { ok: boolean }
fill({ selector: string, value: string }): { ok: boolean }
dispatch_input({ events: CdpInputEvent[] }): { ok: boolean }     // raw CDP Input
query_dom({ selector: string }): { nodes: DomNode[] }
set_dom({ selector: string, html: string }): { ok: boolean }     // into target page only
eval_in_page({ expression: string }): { resultText: string }     // Runtime.evaluate in target; result rendered as text
set_emulation({ device?, viewport?, media? }): { ok: boolean }
```

### 3.4 Network inspection & interception — R / M
```ts
get_network_log({ since?: string }): NetworkEntry[]                       // R
get_request({ requestId: string }): { request, response, bodyRef }       // R
set_intercept_rule({ pattern, action, modify? }): { ruleId: string }     // M — CDP Fetch rewrite
replay_request({ base: RequestSpec, overrides?: Partial<RequestSpec> }): { response, bodyRef }  // M — scope-checked; the send primitive 5.E tools call
```

### 3.5 Active probes / exploit — M / D
```ts
submit_form({ formRef, values }): { response, bodyRef }                   // M
probe_reflection({ target, marker? }): { reflected: boolean, contexts }   // M — benign markers, detection not weaponization
vary_parameter({ base: RequestSpec, param, values[] }): { diffs: Diff[] } // M — rate-limited; IDOR/BAC + differential
run_tool({ tool, argv[], caps }): { exitCode, stdoutRef, stderrRef }      // D — brokered external binaries; POST-MVP (§8.6)
```

### 3.6 Verify & evidence — R
```ts
reproduce({ interactionRef }): { matched: boolean, traceRef }
collect_evidence({ include: ("screenshot"|"reqresp"|"trace")[] }): { traceRef }
get_trace({ ref: string }): { ref, kind, ts, bytes, encoding: "utf8"|"base64"|null, data: string|null, truncated: boolean }
// get_trace resolves a traceRef into its stored contents — text as-is, binary
// (screenshots) base64. Over the inline cap it returns metadata only (data:null,
// truncated:true) so a full-page capture can't flood the context.
```

### 3.7 Findings & history
```ts
record_finding({ schema: FindingSchema, evidenceRef: string }): { findingId }  // writes findings table, NOT audit log; requires evidence
query_log({ filter: LogFilter }): LogRow[]      // R — agent's ONLY history access; structured, never a DB handle
```

### 3.8 Custom capability tools — 5.E, Dev 1 — R / P  (pure-compute, never egress)
```ts
gen_fuzz_payloads({ corpus, encodings?, boundaries? }): { payloads: string[] }     // R
break_regex({ pattern: string }): { redosCandidates: string[], notes }             // R
diff_responses({ a: ResponseRef, b: ResponseRef }): { delta }                      // R
detect_encoding({ bodyRef: string }): { encodings: string[], entropy: number }     // R
mutate_payload({ seed: string, strategy }): { variants: string[] }                 // R
```
These return **data**; the agent feeds results into §3.4 `replay_request` / §3.2 `navigate` to actually send. No socket, no DNS, no file.

### 3.9 Never exposed
`cdp.send` (raw), `Target.*` / `Browser.*` create/attach, any shell / file / eval-into-UI capability.

**MVP subset:** 3.1 + 3.2 + 3.3 + `screenshot` + `query_log` + `record_finding` + `probe_reflection`. Interception, `vary_parameter`, `run_tool`, and most of 5.E land after the spine is green.

---

## 4. Cross-cutting

- **Error envelope** (IPC + MCP): `{ error: { code: string, message: string, retriable: boolean } }`. Tool errors also produce a `tool.result { ok:false, error }` and an audit row.
- **IDs:** `engagementId`, `messageId`, `callId`, `approvalId` all Main-issued, stable, correlate IPC ↔ store rows. `traceRef` / `bodyRef` / `resultRef` are opaque handles into `traces` (6.4), never inline blobs over the bridge.
- **Versioning:** bump a `CONTRACTS_VERSION` when any 🔒 shape changes; the spike records the resolved ⏳ shapes and flips them to 🔒 with a date.

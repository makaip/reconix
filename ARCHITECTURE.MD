# ARCHITECTURE.md

## Reconix — AI-Driven Penetration-Testing Browser

**Stack:** Electron (TS) · Chromium/CDP · OpenCode 2.0 (agent runtime, self-hosted via Docker) · MCP tool layer · self-hosted inference
**Status:** Design locked for MVP. Built by 4 engineers who implement exclusively through coding agents.

> This is a v2 rewrite. It supersedes the original two-browser design. If you read the old doc, the headline changes are: (1) **single Electron-owned browser**, not a separate Playwright instance; (2) **MCP is the enforcement chokepoint**; (3) **scope is enforced at the container network boundary**, not just per-tool; (4) **we self-host the model** and own that infra; (5) the agent drives Chromium through **per-domain CDP wrappers**, never raw `cdp.send`.

---

## 0. How to use this document (read this first)

Everyone on this team writes code by directing coding agents. That changes how we have to work, and this doc is built for it:

1. **Contracts are frozen before implementation.** The seams between the four workstreams (Section 6) are fixed first and do not change without all four people agreeing. An agent implementing one component must be able to code against a *stable* description of everything it talks to. Moving a contract mid-build silently invalidates three other people's agent context.
2. **Each workstream is a self-contained vertical.** One person + their agent owns one vertical (Section 4). The component spec for that vertical (Section 5) is written to be pasted into an agent as context with minimal external reading.
3. **Mock at the seams, integrate late.** Build your vertical against *mocked* versions of the contracts (a fake MCP tool, a stub IPC bridge, a canned model endpoint). Don't wait on another person's real implementation. Integration is a scheduled event, not an assumption.
4. **The spine spike comes before everything (Section 7).** Because OpenCode 2.0's API is beta and moving, we prove the end-to-end round trip *once, together*, before anyone builds a vertical on top of assumptions.
5. **Pin every version.** OpenCode, the SDK, the model weights, the base images. Beta surfaces move between releases. Record exact versions in `VERSIONS.lock` and treat upgrades as deliberate, reviewed events.

When you hand a section to an agent, hand it: this doc's Section 6 (contracts), the Section 5 subsection for your vertical, and Section 3 (overview) for context. That is enough to start.

---

## 1. Objectives & non-goals

**Objectives**
- Observable autonomy — every agent action is visible in a real browser viewport the human can watch.
- Human-in-the-loop safety — mutating/destructive actions pause for explicit approval.
- Hard scope containment — the system is *physically incapable* of acting outside the authorized engagement scope, not merely instructed to stay in it.
- Traceable output — every action and approval is recorded as a semantic audit artifact that backs the report and the engagement's legal defensibility.
- Self-reliant inference — we run our own model; no third-party provider sees target data or our prompts.

**Non-goals (MVP)**
- Distributed/multi-target scanning, multi-user collaboration, compliance-template reporting (OWASP ASVS/PCI mappings), dynamic agent-authored tooling. All deferred.

---

## 2. Threat & trust model (the frame everything else serves)

- **The target is hostile by assumption.** We deliberately load attacker-authored content all day. The target's DOM/JS is untrusted input — not because the target is defending against us, but because we don't author it.
- **The agent is capable but not trusted as a boundary.** It can be wrong, confused by injected content, or jailbroken. Security must not depend on the agent behaving. Enforcement lives in layers the agent cannot reach.
- **OpenCode's process is privileged-but-untrusted.** Its tools/plugins can run arbitrary code; it runs isolated in its own container. Its permission system is a *policy/UX* layer, never our containment boundary.
- **Containment is layered, and the layers fail differently.** Per-tool checks are precise and semantic; the network boundary is a blunt catch-all; process/partition isolation bounds blast radius. We rely on their intersection, never a single wall.

The recurring test for any component that touches the target: **"if the agent sends the worst possible input here, what's the damage?"** If the answer depends on the agent being well-behaved, it's not done.

---

## 3. System overview

```
┌──────────────────────────── Electron App (host, privileged) ─────────────────────────────┐
│                                                                                            │
│  Renderer (sandboxed Chromium UI)          Preload (contextBridge)        Main (Node)      │
│  ┌───────────────────────────────┐         ┌────────────────────┐    ┌──────────────────┐ │
│  │ Chat/agent transcript         │◀───IPC──▶│ window.reconix.*   │◀──▶│ IPC hub          │ │
│  │ Live viewport (target mirror) │  (named, │ (narrow, fixed,    │    │ OpenCode adapter │ │
│  │ Approval surface (inline)     │  typed)  │  no-code-channel)  │    │ SSE→IPC fan-out  │ │
│  │ Report preview                │         └────────────────────┘    │ Engagement store │ │
│  └───────────────────────────────┘                                   │ (SQLite, host)   │ │
│                                                                       │ MCP tool server  │ │
│  Target browser (separate WebContentsView, sandboxed, own partition)  │ CDP driver       │ │
│  ┌───────────────────────────────┐                                   └───────┬──────────┘ │
│  │ target page under test        │◀────────────── CDP ──────────────────────▶│            │
│  │ (no Node, isolated partition) │                                           │            │
│  └───────────────────────────────┘                                           │            │
└──────────────────────────────────────────────────────────────────────────────┼───────────┘
                                                                                 │ HTTP + SSE
                                              ┌──────────────────────────────────▼──────────┐
                                              │ Docker: OpenCode server (0.0.0.0 in-container)│
                                              │  planner + Recon/Exploit/Verify subagents     │
                                              │  model router → self-hosted inference         │
                                              │  built-in shell/file tools DISABLED           │
                                              │  reaches browser ONLY via MCP tool server     │
                                              └───────────────┬───────────────────────────────┘
                                                              │ all egress
                                              ┌───────────────▼───────────────────────────────┐
                                              │ Egress proxy (scope allowlist + logging)        │
                                              │  + nftables floor (drop non-target dests)       │
                                              └───────────────┬───────────────────────────────┘
                                                      ┌───────┴────────┐
                                              in-scope target(s)   self-hosted inference endpoint
```

Data flow of one agent action: human goal → Main → OpenCode session → subagent selects an **MCP tool** → OpenCode permission hook fires for mutating/destructive tiers → Main relays approval request → human decides in transcript → Main responds via SDK → tool handler (in Main) scope-checks, drives the target view over CDP, writes the audit record as a side effect → result streams back → Main fans out to renderer and persists.

---

## 4. The four workstreams (ownership)

Each person owns one vertical end to end. The letter is used throughout Section 5.

| Owner | Vertical | Owns | Talks to (contracts) |
|---|---|---|---|
| **A** | **Frontend / Electron shell** | Renderer UI (chat transcript, viewport, approval surface, report preview), preload bridge, window/`WebContentsView` wiring | IPC contract (6.1) |
| **B** | **Orchestration & Data** | Main process: OpenCode lifecycle + SDK adapter, SSE→IPC fan-out, approval relay, SQLite engagement store, audit logging | IPC (6.1), MCP (6.2), OpenCode events (6.3), DB schema (6.4), model endpoint (6.6) |
| **C** | **Tools & Browser control** | MCP tool server, per-domain CDP wrappers, scope checks in handlers, target-view lifecycle & hardening | MCP (6.2), DB write-through (6.4), scope config (6.5) |
| **D** | **Platform / Security / Model** | Docker compose, egress proxy + nftables, OpenCode config & built-in lockdown, self-hosted inference serving, `VERSIONS.lock` | scope config (6.5), model endpoint (6.6), OpenCode config |

The seams between these four are Section 6. If you find yourself needing to know *how* another vertical works internally, stop — you should only need its contract.

---

## 5. Component specs

### 5.A Frontend / Electron shell (Owner A)

**Renderer** is a pure view. No Node, no filesystem, no authoritative state — it renders what Main broadcasts and sends user intent back.

- `webPreferences` for the **UI window**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The UI never gets Node.
- All Main↔Renderer traffic goes through the **preload contextBridge** exposing `window.reconix.*` — a narrow, fixed, named API (6.1). **No method accepts a code string or acts as an eval channel.** There is no path by which agent-chosen code executes in the UI window.
- **Render all target-derived content as text, never markup.** Response bodies, titles, reflected payloads, headers, tool outputs — text nodes only. No `innerHTML`/`dangerouslySetInnerHTML` on anything that originated outside our own code. This is the single most likely real bug in the whole system; it is a standing rule for every PR in this vertical.
- Apply a strict CSP to the UI (`default-src 'self'`, no `unsafe-inline`) as a backstop.

**The chat transcript is an agent transcript, not a chatbot.** It interleaves user messages, agent reasoning, tool calls, and **inline approval requests**. Approvals are not a separate modal system — they arrive as events in the same stream (6.1 `agent:event`) and render in place with approve / deny / edit controls.

**Viewport:** the target renders in its own `WebContentsView`. For MVP, show it directly (it's a real view in our app). Decision still open (Section 8) on whether the human interacts with it directly vs. a controlled overlay; build the pane to display first, wire interaction behind a flag.

**Target `WebContentsView` hardening** (A owns the wiring; C owns the CDP driving of it): `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true` (never disabled), its own `session` partition (`persist:target-<engagementId>`) never shared with the UI, `setPermissionRequestHandler`/`setPermissionCheckHandler` deny-all by default, `will-navigate` + `setWindowOpenHandler` gated by the scope check. No privileged preload on the target view.

### 5.B Orchestration & Data (Owner B)

**OpenCode adapter.** Main spawns OpenCode (via D's Docker setup), connects over HTTP with `@opencode-ai/sdk` (`createOpencodeClient({ baseUrl, ... }`), `createOpencodeServer` as fallback launcher). One OpenCode **session per engagement**; session history is held server-side so prompts don't resend the transcript.

- Server binds `0.0.0.0` **inside** the container; the port is published to `127.0.0.1` on the host (D owns the mapping). Connect to `http://127.0.0.1:<hostPort>`.
- `OPENCODE_SERVER_PASSWORD` is set at spawn and passed to the client.
- **Supervision:** readiness wait before first use, auto-restart with backoff, connection-status surfaced to the UI.

**Event fan-out.** OpenCode streams events (assistant output, reasoning, tool calls, permission requests) over SSE. Main subscribes, and for every event does two things: (1) forward to the renderer as `agent:event` (6.1), and (2) persist to the engagement store (6.4). *Capture-as-you-stream* — the audit record is a side effect of events passing through, not a separate step.

**Approval relay.** When a permission request arrives, Main forwards it to the UI, blocks, and on the human's response sends the decision back through the SDK to unblock OpenCode. Main is transport + policy relay; the UI makes the decision.

**Engagement store (SQLite, on the host — Main side, so container death never loses it).** B owns the schema (6.4) and the write path. Two record classes that must stay distinct:
- **Audit log** (`tool_calls`, `approvals`) — append-only, written by the tool layer as a mechanical consequence of execution. The legal/evidence artifact. The agent can never write here.
- **Findings** (`findings`) — the agent's evidence-backed conclusions, human-reviewed. Separate store, separate table.

The agent's *only* read access to its history is via the `query_log` MCP tool (C builds it, B backs it) — a narrow structured query, never a DB handle.

### 5.C Tools & Browser control (Owner C)

**C owns the MCP tool server** — the agent's entire means of affecting anything. See the full catalog in the Appendix; the governing rules:

1. **The tool surface is the allowlist.** A capability that isn't a named tool with a typed schema cannot be expressed by the agent. There is no generic passthrough, no `eval`-shaped tool, no raw DB/socket/shell.
2. **Handlers validate as hostile, then scope-check, before acting.** Schema validation (structural) catches malformed; *policy* validation (semantic — is this URL/target in scope) catches the well-formed bad thing. The handler never trusts that the agent "already checked."
3. **Risk tier per tool** drives gating: **R** read-only (auto), **P** page-mutating/sandbox-only (auto), **M** mutating (approval), **D** destructive (explicit approval + rate-limit). Tier is also what OpenCode's permission config keys off.
4. **Audit write is inseparable from execute.** Before: intent (tool, resolved params, target, tier). After: outcome (result ref, error, ts). No code path acts without recording.

**CDP strategy — per-domain wrappers, never raw `cdp.send`.** The agent gets *wide* power over the target page and *gated* power over navigation/network, because those two are the scope and isolation boundaries.

- **Page-power domains → wide passthrough tools** (DOM, Runtime, Input, CSS, Emulation, Page-minus-navigate, Network *read*, Fetch *inspect*). These are near-raw in expressiveness — e.g. `eval_in_page(expression)` passes arbitrary expressions — but each is a *named, logged, tiered* tool so the semantic audit line and tier survive. Safe to be generous here: the target view is process-isolated and has no Node, and any network it generates hits D's egress proxy.
- **Scope-critical methods → stay named & gated.** `navigate` is its own scope-checked tool. Network/Fetch *rewriting* (`set_intercept_rule`, `replay_request`) is its own gated tool. Not because the agent is untrusted with the page, but because these methods *are* the scope boundary.
- **Never exposed:** `Target.*`/`Browser.*` target creation/attachment — that's a path out of the one isolated view. Raw `cdp.send` is rejected outright: it has no handler, so scope, logging, and tiering all evaporate at once.

**C owns driving the target `WebContentsView` over CDP** (attach the debugger to target views *only*, never the UI's `webContents` — assert this at every `Runtime.evaluate` call site).

### 5.D Platform / Security / Model (Owner D)

**Docker & OpenCode hardening.**
- OpenCode runs in its own container. Compose file, image pinning, volume for OpenCode session data (optional — our audit store is source of truth; mount only if restart-survival of OpenCode's own sessions is wanted).
- **Disable OpenCode built-in tools — shell and file-edit especially.** This is load-bearing: MCP enforcement only holds if MCP is the *only* path out. Audit everything OpenCode exposes by default; the agent's visible tool list must be exactly our MCP tools and nothing else. A reachable built-in shell routes around scope, audit, tiering, and approval in one move.

**Network enforcement — the piece that lets everything upstream relax.**
- The OpenCode container has **no free egress.** Its only route out is the **egress proxy**, which holds the scope allowlist: in-scope destination → forwarded + logged; anything else → dropped + logged.
- An **nftables/iptables floor** drops any packet to a non-target address even if the proxy is bypassed — the dumb wall behind the smart one. Non-HTTP traffic (raw sockets, DNS exfil) dies here.
- **Rate-limiting lives at the proxy.** Scope control bounds *where* traffic goes, not *how hard* it hits an in-scope host — a fuzzer flattening an in-scope prod box is still in-scope and still bad. Rate limits + "is this target safe to pound" stays a human-gated judgment.
- The self-hosted inference endpoint is an **allowed internal destination** in the proxy config — the container must reach the model, and that path is explicit, not open internet.

**Self-hosted model (Section 9).** D owns serving, selection, and the endpoint contract (6.6).

---

## 6. Frozen contracts (the seams)

> Changing anything in this section requires all four owners to agree, because each change invalidates agent context elsewhere. Version this section; date every change.

### 6.1 IPC contract (A ↔ B)

Renderer → Main (via `window.reconix.*`, `ipcRenderer.invoke`):

| Method | Payload | Purpose |
|---|---|---|
| `startEngagement` | `{ goal, scope, policy }` | begin a run |
| `sendMessage` | `{ text }` | user message into the agent session |
| `respondApproval` | `{ approvalId, decision, editedParams? }` | human decision on a gated action |
| `pause` / `resume` | `{}` | global pause/resume |
| `exportReport` | `{ format }` | render/export |
| `queryHistory` | `{ filter }` | read engagement store for display |

Main → Renderer (via `webContents.send`, consumed through preload `on`):

| Channel | Payload | Purpose |
|---|---|---|
| `agent:event` | normalized event (`kind`, body) — covers message deltas, reasoning, tool calls, **approval requests**, results | the one transcript stream |
| `viewport:state` | current target view status | viewport chrome |
| `server:status` | `{ state, detail }` | OpenCode connection banner |
| `finding:new` | finding object | live report |

Payloads are structured-cloneable only (no functions/class instances across the bridge).

### 6.2 MCP tool contract (OpenCode ↔ C)

Each tool declares `{ name, description, inputSchema (JSON Schema), outputSchema, riskTier }`. The full catalog is the Appendix. B and A treat tools as opaque by name + tier; C owns their internals. Adding a tool requires: narrowest-version check, worst-argument check, tier assignment (Section 2 test).

### 6.3 OpenCode event contract (OpenCode → B)

B normalizes OpenCode's SSE events into the `agent:event` shape above. **Exact event names and the permission request/response API are verified against the pinned SDK version during the spine spike (Section 7) and recorded here then.** (Beta surface — do not hardcode from memory.)

### 6.4 Engagement store schema (B owns; C writes audit through B's logger)

- `engagements(id, goal, scope_json, policy_json, started_at, stopped_at, status)`
- `messages(id, engagement_id, role, content, ts)` — transcript (cheap passenger)
- `tool_calls(id, engagement_id, tool, params_json, target, risk_tier, result_ref, error, ts)` — **audit, append-only**
- `approvals(id, tool_call_id, decision, edited_params_json, actor, ts)` — **audit, append-only**
- `findings(id, engagement_id, schema_json, evidence_ref, status, ts)` — agent conclusions, human-reviewed
- `traces(id, engagement_id, kind, path)` — refs to HAR/screenshots stored as files on disk

`tool_calls` + `approvals` are the reason this store exists. Exact column refinement is an open item (Section 8) but the shape is frozen.

### 6.5 Scope config (D defines; C enforces per-tool; D enforces at network)

A single scope definition is the source of truth, consumed in two places: C's handlers (semantic per-action check) and D's proxy/nftables (network floor). Shape: `{ allowed_hosts[], allowed_cidrs[], denied[], rate_limits{} }`. One representation, two enforcement layers — they must read the same object.

### 6.6 Model endpoint contract (D serves; B/OpenCode consume)

D serves an **OpenAI-compatible** inference endpoint (`/v1/chat/completions` with **tool/function-calling** support). OpenCode's model router points at it. Contract: base URL, model name(s), max context, auth token, and a declared guarantee of reliable tool-call formatting. See Section 9.

---

## 7. Build sequencing

**Phase 0 — the spine spike (all four, together, before verticals).**
Prove, in a bare script with `console.log` instead of a UI: Docker-spawn OpenCode → HTTP-connect via SDK → create session → send a prompt → register **one** trivial MCP tool → watch the tool call come back → watch **one permission event fire** → respond to it → confirm the model endpoint (self-hosted) actually serves the completion with a tool call. This de-risks the beta API and the serving stack at once. **Record the resolved 6.3 and 6.6 details here.** Nothing else starts until this round trip is green.

**Phase 1 — parallel verticals against mocks.**
- A builds the UI + bridge against a mock `agent:event` emitter and a fake approval.
- B builds the adapter + store against the spike's real OpenCode + a mock tool.
- C builds the MCP server + CDP wrappers against a real `WebContentsView` + a mock scope config.
- D builds Docker + proxy + nftables + the served model, and the OpenCode lockdown config.

**Phase 2 — integrate at the seams**, in this order: B↔D (adapter to real container + real model) → C↔B (real tools logging to real store) → A↔B (real transcript + approvals) → C target view ↔ A viewport.

**Phase 3 — the loop**, against **deliberately-vulnerable localhost targets only** (OWASP Juice Shop, DVWA). Recon → probe → finding → report, end to end. No real target until scope enforcement (6.5 both layers) is proven.

---

## 8. Open decisions (tracked, non-blocking for MVP)

1. **Recon extraction schema** — exact fields per extracted entity (forms/inputs/endpoints/links), and how identity (url + selector + dom-state ref) is encoded so Verify can reproduce. Everything recon-shaped keys off this. *Owner: C + B.*
2. **`navigate` / `get_dom_extract` return shapes** — the concrete data contract tool outputs return into. *Owner: C.*
3. **Engagement-store column refinement** — precise columns/indexes for `tool_calls` and `approvals`. *Owner: B.*
4. **Viewport interaction model** — human watches a mirror vs. interacts with the target view directly (and if direct, how input is mediated). *Owner: A.*
5. **Egress proxy specifics** — proxy choice, how scope rules compile to proxy + nftables config, where rate-limiting sits. *Owner: D.*
6. **Code-gen / `run_tool` / sandbox tiers** — brokered external tools (nmap/nuclei/sqlmap): allowlist, argv-not-shell, resource caps, microVM tier. Deferred; reactivates the untrusted-code question when turned on. *Owner: C + D.*

---

## 9. Self-hosted model (new responsibility — Owner D)

We run our own inference. This removes any third-party provider from the target-data path and makes the model a component we own, operate, and secure.

**Why it's a real workstream, not a config line:**

- **Tool-calling is a hard selection constraint.** OpenCode is agentic — the model must emit reliable, well-formed tool calls. Many open-weight models are weak at this. Model choice is gated on *demonstrated* tool-call reliability against our MCP schemas, verified in the Phase-0 spike. A model that reasons well but tool-calls poorly is disqualified.
- **Two model roles** (from the recon design): a *cheap/fast* model for per-page DOM extraction, a *stronger* model for planner/exploit reasoning over the accumulated structured extracts (where the larger context window is spent). Serve either as two models or one model at two settings; OpenCode's model router selects per step. The extractor's context can be small; the planner's should be roomy.
- **Serving stack.** An OpenAI-compatible server (e.g. vLLM / TGI / SGLang class) exposing `/v1/chat/completions` with function-calling. D owns GPU provisioning, the serving process, weight management, and throughput/latency targets. Pin weights + server version in `VERSIONS.lock`.

**Security responsibilities (the model is in the trust path):**

- **Lock the endpoint down.** It is reachable only from the OpenCode container, via an auth token, over an internal address that is an *explicit allowed destination* in the egress proxy — never exposed to the open internet, never on `0.0.0.0` publicly.
- **The model reads untrusted DOM.** Same robustness property as the rest of the system: the extractor model is fed attacker-authored content and must be kept on a tight extract-to-schema contract that it cannot be talked out of. It emits structured data only; it never takes actions — actions are the agent's MCP calls, which are separately gated. A page that tries to prompt-inject the extractor can corrupt an extraction (a reliability bug) but cannot cause an out-of-scope or unlogged action (those are enforced downstream, not by the model).
- **Prompts and target data stay in-house.** The reason we self-host: nothing about the engagement leaves our infrastructure. Treat the inference logs with the same care as the audit store — they contain target data.

**Ops:**

- Capacity: the per-page extractor runs at high frequency across a crawl — size serving for that load, not for the occasional planner call. The extractor is the throughput driver.
- Failure mode: if inference is down, the agent is dead. Surface model-endpoint health alongside OpenCode `server:status`; the supervision story (7, B's adapter) must cover "model unreachable," not just "OpenCode unreachable."

---

## 10. Security model summary (consolidated)

Layered, intersecting, failing differently:

| Layer | Enforces | Owner |
|---|---|---|
| Tool surface = allowlist | agent can only express named capabilities | C |
| Handler validation + scope check | well-formed-bad-input rejected before action | C |
| Risk tier + OpenCode permission hook | mutating/destructive pause for human | C + B |
| OpenCode built-ins disabled | MCP is the *only* path out | D |
| Egress proxy (scope + log) | traffic can only reach in-scope targets; network audit | D |
| nftables floor | non-target destinations dropped even if proxy bypassed | D |
| Container isolation | OpenCode's arbitrary-code risk bounded to the box | D |
| Target-view sandbox + partition | hostile page can't reach UI or escape its view | A + C |
| Render-as-text rule | target content can't execute in our UI | A |
| Audit-as-side-effect | complete, unforgeable record of actions + approvals | B + C |
| Self-hosted, locked inference | target data never leaves our infra; model can't be a pivot | D |

No single layer is trusted to be airtight. The agent is contained by their intersection: it can only act through tools, the tools won't do unsafe things, anything routing around the tools still can't leave the box, and everything that happens is recorded.

---

## Appendix — MCP tool catalog

Tiers: **R** read-only (auto) · **P** page-mutating, sandbox-only (auto) · **M** mutating (approval) · **D** destructive (explicit approval + rate-limit). All tools scope-checked at handler + backstopped by egress proxy; all log as a side effect.

**Session & scope (R):** `get_scope` · `get_engagement_state`

**Navigation & page read (R):** `navigate` *(scope-checked; returns status + final post-redirect url + compact extract)* · `get_page_info` · `get_dom_extract` *(schema'd: forms/inputs/endpoints/links in+out of scope/headers/CSRF presence, each with identity)* · `list_forms` · `list_links` · `get_headers` · `get_cookies` · `screenshot`

**Page interaction & CDP page-power (P):** `click` · `fill` · `dispatch_input` *(raw CDP Input)* · `query_dom` · `set_dom` · `eval_in_page` *(arbitrary Runtime.evaluate in target page; output rendered as text in UI)* · `set_emulation` *(CSS/Emulation)*

**Network inspection & interception (R/M):** `get_network_log` (R) · `get_request` (R) · `set_intercept_rule` (M, CDP Fetch rewrite) · `replay_request` (M, scope-checked)

**Active probes / exploit (M/D):** `submit_form` (M) · `probe_reflection` (M, benign markers — detection not weaponization) · `vary_parameter` (M, rate-limited — IDOR/BAC + fuzzing differential) · `run_tool` (D, brokered external binaries — **post-MVP**, see 8.6)

**Verify & evidence (R):** `reproduce` *(replay stored interaction)* · `collect_evidence` *(screenshot + req/resp + trace ref)*

**Findings & history:** `record_finding` *(agent conclusions; requires evidence/trace ref; human-reviewed; writes findings table NOT audit log)* · `query_log` (R) *(agent's only history access; narrow structured query, never a DB handle)*

**MVP subset:** session/scope + navigation/read + page-interaction + `screenshot` + `query_log` + `record_finding` + `probe_reflection`. Network interception, `vary_parameter`, `run_tool` come after the spine is green.

**Never exposed:** raw `cdp.send`, `Target.*`/`Browser.*` creation/attach, any shell/file/eval-into-UI capability.
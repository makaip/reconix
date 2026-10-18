# Reconix

> *An AI-driven penetration-testing browser*

Reconix pairs a real browser (with built-in traffic-interception tooling) against an autonomous AI agent that actively probes web applications for vulnerabilities, while a human stays in the loop for anything destructive.

`Electron` · `TypeScript` · `React` · `OpenCode` · `vLLM` · `Chrome DevTools Protocol`

---

## Inspiration

Manual penetration testing is slow and repetitive: a human tester has to map an application's attack surface by hand before they can even start forming hypotheses about where it's weak. On the other extreme, industry-automated scanners trade that slowness for blindness — they fire thousands of generic payloads with no understanding of what the application actually does, drowning testers in false positives and missing anything that requires real context. Neither extreme keeps a human in the decision loop where it matters.

We wanted to see how far an LLM agent could get at the recon-and-hypothesis part of that work — reasoning over a real browser instead of a headless scraper, so a human can actually watch what it's doing, follow its logic, and step in before anything risky executes.

---

## What It Does

Reconix is an Electron-based browser with:

- **A target browser pane** the agent drives directly, so every action it takes is visible in real time — not a black box.
- **DevTools-grade traffic tooling** built in: request interception, a Repeater (save/edit/resend requests), passive sitemap building from crawl history, request-history search, and HAR export.
- **A multi-agent AI copilot**, split by role so expensive reasoning stays off the hot path:
  - **Orchestrator** — the lead strategist. Maps the attack surface, forms testable hypotheses ("this input looks reflected, might be XSS"), and directs the other agents.
  - **Parser** — pulls raw HTML, DOM trees, and accessibility trees into structured data the orchestrator can reason over without drowning in markup.
  - **Analyzer** — inspects that structured output (and live page state) to surface forms, inputs, event handlers, and other attack-surface detail the orchestrator can act on.
  - **Evaluator** — reviews execution logs, DOM changes, and network responses against each hypothesis with strict evidence-based reasoning, filtering out false positives before anything becomes a reported finding.
- **Human-in-the-loop approval** — any mutating or destructive action an agent wants to take pauses for explicit sign-off before it executes.
- **Hard scope enforcement** — the agent's network access is boxed in by an engagement scope config, checked both in-process and (in the containerized deployment) at an egress proxy, so it is structurally unable to touch anything outside the authorized target.

---

## How We Built It

- **Electron + TypeScript** for the desktop shell — a sandboxed renderer (UI) and an isolated target `WebContentsView` (the page under test), talking over a narrow typed IPC bridge.
- **OpenCode** as the agent runtime, with the orchestrator delegating to three specialized subagents (parser, analyzer, evaluator) to keep expensive reasoning off the hot path.
- **Self-hosted inference via vLLM** — no target data or prompts leave our own infrastructure.
- **Chrome DevTools Protocol (CDP)** to drive the target page and build the traffic-capture tooling.
- **Custom pure-compute tools** (JWT decode, fuzz-payload generation, response diffing, secret detection, TLS inspection, cookie-flag analysis, ReDoS detection) the agent can call during its reasoning loop.

---

## Challenges We Ran Into

- Getting tool-calling reliable out of a small self-hosted model was harder than expected — had to tier models (fast/cheap for DOM extraction, stronger for planning) to keep both quality and latency workable.
- Deciding where enforcement actually has to live: per-tool checks alone aren't enough if something can route around the agent's tool layer entirely, so scope checking ended up needing to live at multiple layers that all have to agree.

---

## What's Next

- placeholder

## Local CVE-Bench test

Start the bundled CVE-2024-2624 target, then open `http://localhost:9090` in Reconix:

```sh
docker compose -f test/cve-bench/compose.yml up -d --wait
```

See [the CVE-Bench harness guide](test/cve-bench/README.md) for grader access,
port overrides, logs, and cleanup.

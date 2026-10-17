// Fast, non-Electron sanity check that runs BEFORE the app launches (wired as
// predev/prestart below). Catches exactly the class of failure that
// otherwise only shows up as a cryptic runtime crash inside copilot.ts once
// the window is already open — e.g. "Is port 4097 in use?" from a stale
// `opencode serve` left running by a previous crashed session.
//
//   node scripts/preflight.mjs
//
// Exits non-zero (and prints a one-line fix for each failure) if anything
// here would make the Copilot bridge fail to start. Never launches Electron
// or opencode itself — just checks the preconditions.
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, join } from 'node:path'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '..')

const failures = []
const warnings = []
const ok = (msg) => console.log(`\x1b[32mPASS\x1b[0m  ${msg}`)
const fail = (msg, fix) => {
  failures.push(msg)
  console.log(`\x1b[31mFAIL\x1b[0m  ${msg}${fix ? `\n        fix: ${fix}` : ''}`)
}
const warn = (msg, fix) => {
  warnings.push(msg)
  console.log(`\x1b[33mWARN\x1b[0m  ${msg}${fix ? `\n        fix: ${fix}` : ''}`)
}

async function portFree(port) {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

async function pidsOnPort(port) {
  try {
    const { stdout } = await execFileAsync('lsof', ['-ti', `:${port}`])
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return [] // lsof exits 1 with empty stdout when nothing's listening
  }
}

// --- 1. ports the Copilot bridge binds (copilot.ts: OPENCODE_PORT / MCP_PORT) ---
for (const port of [4097, 4101]) {
  if (await portFree(port)) {
    ok(`port ${port} is free`)
    continue
  }
  const pids = await pidsOnPort(port)
  const detail = pids.length ? `held by pid ${pids.join(', ')}` : 'held by an unknown process'
  fail(
    `port ${port} is already in use (${detail})`,
    pids.length
      ? `kill ${pids.join(' ')}   # or: pkill -f "opencode serve"`
      : `lsof -ti :${port} | xargs kill`
  )
}

// --- 2. opencode CLI present and runnable ---
try {
  const { stdout } = await execFileAsync('opencode', ['--version'])
  ok(`opencode CLI found (${stdout.trim()})`)
} catch {
  fail('opencode CLI not found on PATH', 'install it — https://opencode.ai — or fix PATH for this shell')
}

// --- 3. API key available (copilot.ts spawns opencode serve expecting this in env) ---
const envPath = join(repoRoot, '.env')
let envKeyPresent = Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY)
if (!envKeyPresent && existsSync(envPath)) {
  const text = readFileSync(envPath, 'utf8')
  envKeyPresent = /^GOOGLE_GENERATIVE_AI_API_KEY=\S+/m.test(text)
}
if (envKeyPresent) {
  ok('GOOGLE_GENERATIVE_AI_API_KEY is set (env or .env)')
} else {
  fail('GOOGLE_GENERATIVE_AI_API_KEY is missing', `add it to ${envPath} (gitignored) — GOOGLE_GENERATIVE_AI_API_KEY=<key>`)
}

// --- 4. opencode.json parses and references real agent files ---
const opencodeJsonPath = join(repoRoot, 'opencode.json')
let opencodeJson
try {
  opencodeJson = JSON.parse(readFileSync(opencodeJsonPath, 'utf8'))
  ok('opencode.json is valid JSON')
} catch (e) {
  fail(`opencode.json failed to parse: ${e.message}`)
}

const agentsDir = join(repoRoot, '.opencode', 'agents')
const requiredAgents = ['pentest-orchestrator', 'dom-analyzer', 'evaluator']
for (const name of requiredAgents) {
  const path = join(agentsDir, `${name}.md`)
  if (!existsSync(path)) {
    fail(`.opencode/agents/${name}.md is missing`, 'this agent id is referenced by copilot.ts / opencode.json')
    continue
  }
  const body = readFileSync(path, 'utf8')
  const hasFrontmatter = body.startsWith('---\n') && body.indexOf('\n---', 4) !== -1
  if (!hasFrontmatter) {
    fail(`.opencode/agents/${name}.md has no frontmatter block`)
    continue
  }
  if (/model:\s*temp\b/.test(body)) {
    fail(`.opencode/agents/${name}.md still has a placeholder model: temp`, 'point it at a real model id')
    continue
  }
  ok(`.opencode/agents/${name}.md present and configured`)
}

if (opencodeJson?.mcp?.servers?.reconix?.url) {
  ok(`opencode.json wires the reconix MCP server (${opencodeJson.mcp.servers.reconix.url})`)
} else {
  warn('opencode.json has no mcp.servers.reconix entry', 'the orchestrator will have no browser tools')
}

// --- summary ---
console.log('')
if (failures.length) {
  console.log(`\x1b[31m${failures.length} check(s) failed\x1b[0m — fix the above before launching.`)
  process.exit(1)
}
if (warnings.length) {
  console.log(`\x1b[33m${warnings.length} warning(s)\x1b[0m — not blocking, but worth a look.`)
}
console.log('\x1b[32mAll preflight checks passed.\x1b[0m')

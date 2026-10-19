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
const isWindows = process.platform === 'win32'

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

// Windows has no lsof, so try netstat -ano first (always present) and fall back
// to PowerShell's Get-NetTCPConnection. Returns [] if nothing is listening or if
// the tooling is unavailable.
async function pidsOnPortWindows(port) {
  const wanted = String(port)
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'], { windowsHide: true })
    const pids = new Set()
    for (const line of stdout.split(/\r?\n/)) {
      // e.g. "  TCP    0.0.0.0:4097    0.0.0.0:0    LISTENING    12345"
      if (!/LISTENING/i.test(line)) continue
      const cols = line.trim().split(/\s+/)
      const local = cols[1] ?? ''
      const pid = cols[cols.length - 1] ?? ''
      if (!/^\d+$/.test(pid)) continue
      if (local.slice(local.lastIndexOf(':') + 1) === wanted) pids.add(pid)
    }
    return [...pids] // netstat worked; empty means nothing is listening
  } catch {
    // fall through to PowerShell
  }
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`,
      ],
      { windowsHide: true }
    )
    return [...new Set(stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s)))]
  } catch {
    return []
  }
}

async function pidsOnPort(port) {
  if (isWindows) return pidsOnPortWindows(port)
  try {
    const { stdout } = await execFileAsync('lsof', ['-ti', `:${port}`], { windowsHide: true })
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return [] // lsof exits 1 with empty stdout when nothing's listening
  }
}

// Windows ships npm CLI shims (`opencode.cmd`) as well as native binaries
// (`opencode.exe`), and the bare name only resolves through cmd.exe, hence
// shell:true on win32. On Unix a single `opencode` lookup is enough.
async function findOpencode() {
  const candidates = isWindows ? ['opencode', 'opencode.cmd', 'opencode.exe'] : ['opencode']
  const opts = isWindows ? { windowsHide: true, shell: true } : { windowsHide: true }
  const tried = []
  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(bin, ['--version'], opts)
      return { bin, version: stdout.trim() }
    } catch (e) {
      tried.push(`${bin} (${e?.code ?? 'failed'})`)
    }
  }
  return { bin: null, tried }
}

function killHint(pids, port) {
  if (isWindows) {
    return pids.length
      ? `${pids.map((p) => `taskkill /PID ${p} /F`).join(' && ')}   # or: taskkill /IM opencode.exe /F`
      : `netstat -ano | findstr :${port}   # then: taskkill /PID <pid> /F`
  }
  return pids.length
    ? `kill ${pids.join(' ')}   # or: pkill -f "opencode serve"`
    : `lsof -ti :${port} | xargs kill`
}

// --- 1. ports the Copilot bridge binds (copilot.ts: OPENCODE_PORT / MCP_PORT) ---
for (const port of [4097, 4101]) {
  if (await portFree(port)) {
    ok(`port ${port} is free`)
    continue
  }
  const pids = await pidsOnPort(port)
  const detail = pids.length ? `held by pid ${pids.join(', ')}` : 'held by an unknown process'
  fail(`port ${port} is already in use (${detail})`, killHint(pids, port))
}

// --- 2. opencode CLI present and runnable ---
const opencode = await findOpencode()
if (opencode.bin) {
  ok(`opencode CLI found (${opencode.version})`)
} else {
  fail(
    'opencode CLI not found on PATH',
    isWindows
      ? `install it — https://opencode.ai — then check it with: where opencode  (fix PATH for this shell; tried: ${opencode.tried.join(', ')})`
      : 'install it — https://opencode.ai — or fix PATH for this shell'
  )
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
  // Normalize CRLF (Windows checkout) so the frontmatter check is line-ending
  // agnostic; the agent files are committed with LF endings.
  const body = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
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

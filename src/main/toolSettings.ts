// Persistent allowlist for brokered external binaries (`run_tool`, §8.6).
// Stored as `<userData>/external-tool-settings.json`.
//
// Kept free of Electron imports on purpose (the path is injected by the caller,
// index.ts passes app.getPath('userData')), mirroring modelSettings.ts so this
// module stays unit-testable without booting Electron.
//
// Two sources are merged at resolution time: the persisted allowlist (edited in
// Settings ▸ External tools) and RECONIX_RUN_TOOL_ALLOWLIST (deployment-level,
// comma-separated). Env entries are additive so an operator can widen the list
// without editing the user's file; nothing can remove a persisted entry.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

export interface ExternalToolSettings {
  /** PATH-resolved binary names the agent may spawn. Never paths. */
  allowlist: string[]
  /** Broker default for a run that omits its own timeout. run_tool still
   *  enforces its hard ceiling on top of this (see probes.ts). */
  defaultTimeoutMs: number
  /** Broker default capture cap per stream. run_tool still enforces its hard
   *  ceiling on top of this (see probes.ts). */
  maxOutputBytes: number
}

export const DEFAULT_EXTERNAL_TOOL_SETTINGS: ExternalToolSettings = {
  // Empty by default: external binaries are never shipped with Reconix, and
  // §8.6 wants an explicit opt-in before the broker will spawn anything.
  allowlist: [],
  defaultTimeoutMs: 60_000,
  maxOutputBytes: 1_000_000
}

export interface ExternalToolSettingsResult {
  ok: boolean
  error?: string
  settings?: ExternalToolSettings
}

export const EXTERNAL_TOOL_LIMITS = {
  timeoutMs: { min: 1_000, max: 600_000 },
  outputBytes: { min: 4_096, max: 16 * 1024 * 1024 }
} as const

const SETTINGS_FILE = 'external-tool-settings.json'

/** Environment variable read at resolution time (deployment-level allowlist). */
export const ALLOWLIST_ENV_VAR = 'RECONIX_RUN_TOOL_ALLOWLIST'

/** A binary name, never a path: `nmap`, `nuclei`, `nmap.exe`. Rejecting
 *  separators keeps the broker on a pure PATH lookup — a user can't point an
 *  allowlist entry at `../../bin/sh`. */
const BINARY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

export function isValidBinaryName(value: unknown): value is string {
  return typeof value === 'string' && BINARY_NAME_RE.test(value.trim())
}

export function settingsFilePath(userDataPath: string): string {
  return join(userDataPath, SETTINGS_FILE)
}

function cloneDefaults(): ExternalToolSettings {
  return structuredClone(DEFAULT_EXTERNAL_TOOL_SETTINGS)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parses a comma-separated allowlist string (env var or a text input) into
 *  validated, de-duplicated binary names. Invalid entries are dropped rather
 *  than failing the whole list: an env var typo shouldn't disable every other
 *  allowlisted tool. */
export function parseAllowlist(value: unknown): string[] {
  if (typeof value === 'string') {
    return dedupe(value.split(',').map((entry) => entry.trim()).filter(isValidBinaryName))
  }
  if (Array.isArray(value)) {
    return dedupe(value.filter(isValidBinaryName).map((entry) => (entry as string).trim()))
  }
  return []
}

/** Case-insensitive de-dupe that keeps the first spelling seen (Windows binary
 *  names are case-insensitive; the file should still read tidily). */
function dedupe(names: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of names) {
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

function isValidLimit(value: unknown, bounds: { min: number; max: number }): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= bounds.min && value <= bounds.max
}

/** Strict schema validation used by both load (fall back to defaults on
 *  failure) and save (reject before writing). Returns a normalized copy with
 *  unknown fields stripped. */
export function validateExternalToolSettings(input: unknown): ExternalToolSettingsResult {
  if (!isRecord(input)) return { ok: false, error: 'settings must be an object' }

  const rawAllowlist = input.allowlist ?? []
  if (!Array.isArray(rawAllowlist)) return { ok: false, error: 'allowlist must be an array' }
  const allowlist: string[] = []
  const seen = new Set<string>()
  for (const [index, entry] of rawAllowlist.entries()) {
    if (!isValidBinaryName(entry)) {
      return {
        ok: false,
        error: `allowlist[${index}] must be a binary name (letters, digits, ".", "_", "+", "-"), not a path`
      }
    }
    const name = entry.trim()
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    allowlist.push(name)
  }

  const defaultTimeoutMs = input.defaultTimeoutMs ?? DEFAULT_EXTERNAL_TOOL_SETTINGS.defaultTimeoutMs
  if (!isValidLimit(defaultTimeoutMs, EXTERNAL_TOOL_LIMITS.timeoutMs)) {
    return {
      ok: false,
      error: `defaultTimeoutMs must be an integer between ${EXTERNAL_TOOL_LIMITS.timeoutMs.min} and ${EXTERNAL_TOOL_LIMITS.timeoutMs.max}`
    }
  }

  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_EXTERNAL_TOOL_SETTINGS.maxOutputBytes
  if (!isValidLimit(maxOutputBytes, EXTERNAL_TOOL_LIMITS.outputBytes)) {
    return {
      ok: false,
      error: `maxOutputBytes must be an integer between ${EXTERNAL_TOOL_LIMITS.outputBytes.min} and ${EXTERNAL_TOOL_LIMITS.outputBytes.max}`
    }
  }

  return { ok: true, settings: { allowlist, defaultTimeoutMs, maxOutputBytes } }
}

/** Reads the settings file. A missing, unreadable, or invalid file yields the
 *  defaults (logged, never thrown) so a corrupt file can't brick the broker. */
export async function load(userDataPath: string): Promise<ExternalToolSettings> {
  const path = settingsFilePath(userDataPath)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[toolSettings] could not read ${path}; using defaults:`, err)
    }
    return cloneDefaults()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn(`[toolSettings] invalid JSON in ${path}; using defaults:`, err)
    return cloneDefaults()
  }

  const validated = validateExternalToolSettings(parsed)
  if (!validated.ok) {
    console.warn(`[toolSettings] invalid settings in ${path}; using defaults: ${validated.error}`)
    return cloneDefaults()
  }
  return validated.settings as ExternalToolSettings
}

/** Validates and persists (pretty-printed) the settings. Returns ok:false with
 *  an error instead of throwing so IPC callers can surface it inline. */
export async function save(userDataPath: string, input: unknown): Promise<ExternalToolSettingsResult> {
  const validated = validateExternalToolSettings(input)
  if (!validated.ok) return validated
  try {
    await mkdir(userDataPath, { recursive: true })
    await writeFile(settingsFilePath(userDataPath), `${JSON.stringify(validated.settings, null, 2)}\n`)
    cache = { userDataPath, settings: validated.settings as ExternalToolSettings }
    return { ok: true, settings: validated.settings }
  } catch (err) {
    return { ok: false, error: `could not write settings: ${(err as Error).message}` }
  }
}

// ── cache ───────────────────────────────────────────────────────────────────
// run_tool resolves the allowlist on every call; re-reading the file for every
// lookup would be pointless I/O. Invalidated on external-tools:set.
let cache: { userDataPath: string; settings: ExternalToolSettings } | null = null

export function invalidateExternalToolSettingsCache(userDataPath?: string): void {
  if (!userDataPath || cache?.userDataPath === userDataPath) cache = null
}

/** Cached load. The cache is per userData path, so tests with different temp
 *  dirs never see each other's settings. */
export async function loadExternalToolSettings(userDataPath: string): Promise<ExternalToolSettings> {
  if (cache?.userDataPath === userDataPath) return cache.settings
  const settings = await load(userDataPath)
  cache = { userDataPath, settings }
  return settings
}

// ── allowlist resolution ────────────────────────────────────────────────────
// The MCP tools live in main but never receive Electron paths, so index.ts
// injects the userData dir once at boot. Unset (tests, smoke, headless) simply
// means "env only", which is exactly the pre-settings behaviour.
let configuredUserDataPath: string | null = null

export function setExternalToolSettingsPath(userDataPath: string): void {
  configuredUserDataPath = userDataPath
}

/** Persisted ∪ env. Persisted entries come first (that's the order the Settings
 *  panel shows), env-only extras are appended. */
export async function resolveAllowlist(userDataPath?: string): Promise<string[]> {
  return (await resolveToolPolicy(userDataPath)).allowlist
}

/** Everything run_tool needs for one call: the merged allowlist plus the
 *  broker caps. A missing settings file (headless, tests) yields the defaults,
 *  which reproduce the pre-settings behaviour exactly. */
export interface ResolvedToolPolicy {
  allowlist: string[]
  timeoutMs: number
  maxOutputBytes: number
}

export async function resolveToolPolicy(userDataPath?: string): Promise<ResolvedToolPolicy> {
  const dir = userDataPath ?? configuredUserDataPath
  const settings = dir ? await loadExternalToolSettings(dir) : cloneDefaults()
  return {
    allowlist: dedupe([...settings.allowlist, ...parseAllowlist(process.env[ALLOWLIST_ENV_VAR])]),
    timeoutMs: settings.defaultTimeoutMs,
    maxOutputBytes: settings.maxOutputBytes
  }
}

// ── install probe ───────────────────────────────────────────────────────────

export interface ExternalToolProbe {
  name: string
  installed: boolean
  /** Absolute path `which`/`where` reported, when installed. */
  resolvedPath?: string
  /** Reserved: a version string, when it can be read without executing the
   *  binary. Scans never run the discovered binary itself. */
  versionHint?: string
}

const PROBE_TIMEOUT_MS = 2_000
const PROBE_MAX_BUFFER = 64 * 1024
const PROBE_MAX_CANDIDATES = 64

/** `which` on POSIX, `where` on Windows — argv-only, no shell, 2 s timeout.
 *  Never spawns the candidate binary itself: a scan must not execute code just
 *  to learn whether it exists. */
async function probeOne(name: string): Promise<ExternalToolProbe> {
  if (!isValidBinaryName(name)) return { name, installed: false }
  const exec = promisify(execFile)
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await exec(finder, [name], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BUFFER,
      shell: false,
      windowsHide: true
    })
    const resolvedPath = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    return resolvedPath ? { name, installed: true, resolvedPath } : { name, installed: false }
  } catch {
    // Non-zero exit / timeout: not on PATH (or the lookup itself is missing).
    return { name, installed: false }
  }
}

/** Probes each candidate in parallel, preserving the input order. */
export async function probeExternalTools(candidates: string[]): Promise<ExternalToolProbe[]> {
  const names = dedupe(
    candidates.filter(isValidBinaryName).map((name) => name.trim())
  ).slice(0, PROBE_MAX_CANDIDATES)
  return Promise.all(names.map((name) => probeOne(name)))
}

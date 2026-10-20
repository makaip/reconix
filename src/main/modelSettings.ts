// Persistent model/backend selection for the copilot (see
// ~/.opencode/plan/model-swap-settings.md). Stored as
// `<userData>/model-settings.json`.
//
// Kept free of Electron imports on purpose: the path is injected by the caller
// (index.ts passes app.getPath('userData')), which keeps this module unit-
// testable without booting Electron.
//
// v1 note: API keys are stored in plaintext in userData (no safeStorage yet) —
// the settings file is user-scoped like the rest of userData, and keys are
// never logged. Encryption is deferred to v2 per the plan.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const REASONING_LEVELS = ['off', 'low', 'medium', 'high'] as const
export type ReasoningEffort = (typeof REASONING_LEVELS)[number]

/** One selectable model: OpenCode addresses these as `<provider>/<model>`. */
export interface ModelTarget {
  provider: string
  model: string
  /** Optional per-target endpoint override (custom OpenAI-compatible servers). */
  baseUrl?: string | null
  /** Optional per-target key override. Never logged. */
  apiKey?: string | null
}

/** A user-added OpenAI-compatible backend, mirrored into opencode.json. */
export interface CustomBackend {
  id: string
  baseUrl: string
  apiKey: string
  model: string
}

export interface ModelSettings {
  orchestrator: ModelTarget
  domAnalyzer: ModelTarget
  reasoning: ReasoningEffort
  customBackends: CustomBackend[]
}

export type ModelRole = 'orchestrator' | 'domAnalyzer'

export interface SettingsResult {
  ok: boolean
  error?: string
  settings?: ModelSettings
}

const SETTINGS_FILE = 'model-settings.json'

/** Defaults reproduce the previously hardcoded values exactly, so an existing
 *  install with no settings file behaves identically. */
export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  orchestrator: { provider: 'vllm-orchestrator', model: 'orchestrator-model' },
  domAnalyzer: { provider: 'opencode', model: 'grok-code' },
  reasoning: 'medium',
  customBackends: []
}

/** Endpoints for the providers declared statically in opencode.json. Only used
 *  as a fallback by testConnection when the target carries no explicit URL. */
const KNOWN_PROVIDER_ENDPOINTS: Record<string, { baseUrl: string; apiKeyEnv: string }> = {
  'vllm-orchestrator': { baseUrl: '', apiKeyEnv: 'ORCHESTRATOR_API_KEY' },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKeyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY'
  },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' }
}

function cloneDefaults(): ModelSettings {
  return structuredClone(DEFAULT_MODEL_SETTINGS)
}

export function settingsFilePath(userDataPath: string): string {
  return join(userDataPath, SETTINGS_FILE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Only http(s) endpoints are allowed: file:// and data: must never become a
 *  backend URL (scope/safety guard from the plan). */
export function isAllowedBaseUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Returns `${provider}/${model}` — the id OpenCode pins on a session. */
export function getModelSpec(settings: ModelSettings, role: ModelRole): string {
  const target = role === 'orchestrator' ? settings.orchestrator : settings.domAnalyzer
  return `${target.provider}/${target.model}`
}

function validateTarget(raw: unknown, label: string): ModelTarget | string {
  if (!isRecord(raw)) return `${label} must be an object`
  if (!isNonEmptyString(raw.provider)) return `${label}.provider must be a non-empty string`
  if (!isNonEmptyString(raw.model)) return `${label}.model must be a non-empty string`
  const target: ModelTarget = { provider: raw.provider.trim(), model: raw.model.trim() }
  if (raw.baseUrl !== undefined && raw.baseUrl !== null && raw.baseUrl !== '') {
    if (!isAllowedBaseUrl(raw.baseUrl)) return `${label}.baseUrl must be an http(s) URL`
    target.baseUrl = raw.baseUrl.trim()
  }
  if (raw.apiKey !== undefined && raw.apiKey !== null) {
    if (typeof raw.apiKey !== 'string') return `${label}.apiKey must be a string`
    target.apiKey = raw.apiKey
  }
  return target
}

/** Strict schema validation. Used by both load (fall back to defaults on
 *  failure) and save (reject before writing). Returns a normalized copy with
 *  unknown fields stripped. */
export function validateModelSettings(input: unknown): SettingsResult {
  if (!isRecord(input)) return { ok: false, error: 'settings must be an object' }

  const orchestrator = validateTarget(input.orchestrator, 'orchestrator')
  if (typeof orchestrator === 'string') return { ok: false, error: orchestrator }
  const domAnalyzer = validateTarget(input.domAnalyzer, 'domAnalyzer')
  if (typeof domAnalyzer === 'string') return { ok: false, error: domAnalyzer }

  if (!REASONING_LEVELS.includes(input.reasoning as ReasoningEffort)) {
    return { ok: false, error: `reasoning must be one of ${REASONING_LEVELS.join('|')}` }
  }

  const rawBackends = input.customBackends ?? []
  if (!Array.isArray(rawBackends)) return { ok: false, error: 'customBackends must be an array' }
  const customBackends: CustomBackend[] = []
  const seen = new Set<string>()
  for (const [index, raw] of rawBackends.entries()) {
    if (!isRecord(raw)) return { ok: false, error: `customBackends[${index}] must be an object` }
    if (!isNonEmptyString(raw.id)) return { ok: false, error: `customBackends[${index}].id must be non-empty` }
    if (!isNonEmptyString(raw.model)) return { ok: false, error: `customBackends[${index}].model must be non-empty` }
    if (!isAllowedBaseUrl(raw.baseUrl)) {
      return { ok: false, error: `customBackends[${index}].baseUrl must be an http(s) URL` }
    }
    if (raw.apiKey !== undefined && typeof raw.apiKey !== 'string') {
      return { ok: false, error: `customBackends[${index}].apiKey must be a string` }
    }
    const id = raw.id.trim()
    if (seen.has(id)) return { ok: false, error: `duplicate custom backend id: ${id}` }
    seen.add(id)
    customBackends.push({
      id,
      baseUrl: raw.baseUrl.trim(),
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
      model: raw.model.trim()
    })
  }

  return {
    ok: true,
    settings: {
      orchestrator,
      domAnalyzer,
      reasoning: input.reasoning as ReasoningEffort,
      customBackends
    }
  }
}

/** Reads the settings file. A missing, unreadable, or invalid file yields the
 *  defaults (logged, never thrown) so a corrupt file can't brick the copilot. */
export async function load(userDataPath: string): Promise<ModelSettings> {
  const path = settingsFilePath(userDataPath)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[modelSettings] could not read ${path}; using defaults:`, err)
    }
    return cloneDefaults()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn(`[modelSettings] invalid JSON in ${path}; using defaults:`, err)
    return cloneDefaults()
  }

  const validated = validateModelSettings(parsed)
  if (!validated.ok) {
    console.warn(`[modelSettings] invalid settings in ${path}; using defaults: ${validated.error}`)
    return cloneDefaults()
  }
  return validated.settings as ModelSettings
}

/** Validates and persists (pretty-printed) the settings. Returns ok:false with
 *  an error instead of throwing so IPC callers can surface it inline. */
export async function save(userDataPath: string, input: unknown): Promise<SettingsResult> {
  const validated = validateModelSettings(input)
  if (!validated.ok) return validated
  try {
    await mkdir(userDataPath, { recursive: true })
    await writeFile(settingsFilePath(userDataPath), `${JSON.stringify(validated.settings, null, 2)}\n`)
    cache = { userDataPath, settings: validated.settings as ModelSettings }
    return { ok: true, settings: validated.settings }
  } catch (err) {
    return { ok: false, error: `could not write settings: ${(err as Error).message}` }
  }
}

// ── cache ───────────────────────────────────────────────────────────────────
// The copilot resolves the model on every new session; re-reading the file for
// every lookup would be pointless I/O. Invalidated on settings:set.
let cache: { userDataPath: string; settings: ModelSettings } | null = null

export function invalidateModelSettingsCache(userDataPath?: string): void {
  if (!userDataPath || cache?.userDataPath === userDataPath) cache = null
}

/** Cached load. The cache is per userData path, so tests with different temp
 *  dirs never see each other's settings. */
export async function loadModelSettings(userDataPath: string): Promise<ModelSettings> {
  if (cache?.userDataPath === userDataPath) return cache.settings
  const settings = await load(userDataPath)
  cache = { userDataPath, settings }
  return settings
}

/** Synchronous best-effort view for call sites that cannot await (e.g. the usage
 *  meter's model labels). Falls back to defaults when the cache is still cold. */
export function peekModelSettings(): ModelSettings {
  return cache?.settings ?? cloneDefaults()
}

/** Resolves the id OpenCode should pin for a role. */
export async function resolveModelSpec(userDataPath: string, role: ModelRole): Promise<string> {
  return getModelSpec(await loadModelSettings(userDataPath), role)
}

// ── connection test ─────────────────────────────────────────────────────────

export interface TestConnectionResult {
  ok: boolean
  error?: string
  /** Model ids reported by the backend, when it exposes GET /models. */
  models?: string[]
}

export type TestTarget =
  | ModelRole
  | { provider?: string; baseUrl?: string | null; apiKey?: string | null; model?: string }

function resolveTarget(
  settings: ModelSettings,
  target: TestTarget
): { baseUrl: string; apiKey: string | null; model: string | null } {
  const explicit =
    typeof target === 'string' ? (target === 'orchestrator' ? settings.orchestrator : settings.domAnalyzer) : target
  const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

  let baseUrl = asString(explicit.baseUrl)
  let apiKey = typeof explicit.apiKey === 'string' ? explicit.apiKey : null
  const provider = asString(explicit.provider)

  const custom = provider ? settings.customBackends.find((backend) => backend.id === provider) : undefined
  if (custom) {
    baseUrl = baseUrl || custom.baseUrl
    apiKey = apiKey ?? custom.apiKey
  } else if (!baseUrl && provider) {
    const known = KNOWN_PROVIDER_ENDPOINTS[provider]
    // vllm-orchestrator's URL is env-only (reconix.env), mirroring the health
    // probe in copilot.ts.
    if (known) {
      baseUrl =
        provider === 'vllm-orchestrator'
          ? (process.env.ORCHESTRATOR_BASE_URL ?? '').trim()
          : known.baseUrl
      apiKey = apiKey ?? (process.env[known.apiKeyEnv] ?? null)
    }
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model: asString(explicit.model) || null
  }
}

async function readModelsResponse(res: Response): Promise<string[]> {
  try {
    const body = (await res.json()) as { data?: unknown }
    if (!Array.isArray(body.data)) return []
    return body.data
      .map((entry) =>
        isRecord(entry) && typeof entry.id === 'string' ? entry.id : typeof entry === 'string' ? entry : null
      )
      .filter((id): id is string => typeof id === 'string')
      .slice(0, 200)
  } catch {
    return []
  }
}

/** Probes a backend: GET /models (preferred), falling back to a one-token chat
 *  completion when the server doesn't implement /models. Any non-2xx is a
 *  failure — a "test connection" button should surface a bad key, unlike the
 *  liveness poll in copilot.ts which only cares that something is listening. */
export async function testConnection(
  settings: ModelSettings,
  target: TestTarget,
  fetchImpl: typeof fetch = fetch
): Promise<TestConnectionResult> {
  const resolved = resolveTarget(settings, target)
  if (!isAllowedBaseUrl(resolved.baseUrl)) {
    return {
      ok: false,
      error: 'No http(s) endpoint configured for this backend (set a base URL or use a known provider)'
    }
  }

  const headers: Record<string, string> = { accept: 'application/json' }
  if (resolved.apiKey) headers.authorization = `Bearer ${resolved.apiKey}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6_000)

  try {
    const modelsRes = await fetchImpl(`${resolved.baseUrl}/models`, {
      method: 'GET',
      headers,
      signal: controller.signal
    })
    if (modelsRes.ok) {
      return { ok: true, models: await readModelsResponse(modelsRes) }
    }
    if (modelsRes.status !== 404 && modelsRes.status !== 405) {
      return { ok: false, error: `GET /models returned HTTP ${modelsRes.status}` }
    }

    // Some OpenAI-compatible servers only expose chat completions.
    if (!resolved.model) {
      return { ok: false, error: `GET /models returned HTTP ${modelsRes.status} and no model id was given` }
    }
    const chatRes = await fetchImpl(`${resolved.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: resolved.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }]
      }),
      signal: controller.signal
    })
    if (chatRes.ok) return { ok: true }
    const detail = await chatRes.text().catch(() => '')
    return { ok: false, error: `chat completion returned HTTP ${chatRes.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` }
  } catch (err) {
    const message = err instanceof Error && err.name === 'AbortError' ? 'connection timed out' : (err as Error).message
    return { ok: false, error: message }
  } finally {
    clearTimeout(timer)
  }
}

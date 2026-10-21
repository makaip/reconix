import { useEffect, useState } from 'react'
import type { UseSettings } from '../hooks/useSettings'
// Types mirror the preload contract (src/preload/index.ts): window.reconix.settings
// speaks in ModelSettings / SettingsTestTarget shapes over IPC.
import type {
  CustomBackend,
  ExternalToolProbe,
  ExternalToolSettings,
  ModelSettings,
  ModelTarget,
  ReasoningEffort,
  SettingsTestTarget
} from '../../../preload/index'

type SettingsModalProps = {
  settings: UseSettings
  onClose: () => void
}

// ---------------------------------------------------------------------------
// Model section — provider/model selection, reasoning effort, custom backends.
// ---------------------------------------------------------------------------

/** One grouped dropdown entry: OpenCode addresses models as `<provider>/<model>`. */
type ModelOption = { id: string; label: string }
type ModelGroup = { provider: string; options: ModelOption[] }

/** Inline status for one "Test connection" probe (busy | ok | error). */
type Feedback = { kind: 'ok' | 'error'; message: string } | { kind: 'busy' }

/** Sentinel <option> value for the "Custom…" picker choice. */
const CUSTOM_CHOICE = '__custom__'

// Fallback groups used only if the live `settings:list-models` call fails, so
// the dropdowns stay usable offline / in dev without the opencode binary.
const FALLBACK_ORCHESTRATOR_GROUPS: ModelGroup[] = [
  { provider: 'vLLM (local)', options: [{ id: 'vllm-orchestrator/orchestrator-model', label: 'Local Qwen' }] },
  {
    provider: 'Gemini',
    options: [
      { id: 'gemini/gemini-flash-lite-latest', label: 'Gemini Flash Lite (latest)' },
      { id: 'gemini/gemini-2.5-pro', label: 'Gemini 2.5 Pro' }
    ]
  },
  { provider: 'OpenCode', options: [{ id: 'opencode/grok-code', label: 'Grok Code' }] },
  { provider: 'OpenRouter', options: [{ id: 'openrouter/dolphin3-mistral-24b', label: 'Dolphin Mistral 24B' }] }
]

const FALLBACK_DOM_ANALYZER_GROUPS: ModelGroup[] = [
  { provider: 'OpenCode', options: [{ id: 'opencode/grok-code', label: 'Grok Code (default)' }] },
  { provider: 'Gemini', options: [{ id: 'gemini/gemini-flash-lite-latest', label: 'Gemini Flash Lite (latest)' }] }
]

const REASONING_LEVELS: ReasoningEffort[] = ['off', 'low', 'medium', 'high']
const REASONING_LABELS: Record<ReasoningEffort, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High'
}

const specOf = (target: ModelTarget): string => `${target.provider}/${target.model}`

const isKnownSpec = (target: ModelTarget, groups: ModelGroup[]): boolean =>
  groups.some((group) => group.options.some((option) => option.id === specOf(target)))

/** A saved target with no known id is treated as previously-custom when it
 *  carries its own endpoint/key override; otherwise it shows as a raw value. */
const startsCustom = (target: ModelTarget, groups: ModelGroup[]): boolean =>
  !isKnownSpec(target, groups) && Boolean(target.baseUrl || target.apiKey)

const roleTestTarget = (target: ModelTarget): SettingsTestTarget => ({
  provider: target.provider,
  model: target.model,
  baseUrl: target.baseUrl ?? undefined,
  apiKey: target.apiKey ?? undefined
})

const backendTestTarget = (backend: CustomBackend): SettingsTestTarget => ({
  baseUrl: backend.baseUrl,
  apiKey: backend.apiKey,
  model: backend.model
})

const hintClass = (kind: 'ok' | 'error'): string =>
  `settings__row-hint settings__row-hint--${kind}`

type RoleBlockProps = {
  title: string
  target: ModelTarget
  groups: ModelGroup[]
  customSelected: boolean
  test: Feedback | undefined
  onPatch: (patch: Partial<ModelTarget>, custom: boolean) => void
  onTest: () => void
}

function RoleBlock({
  title,
  target,
  groups,
  customSelected,
  test,
  onPatch,
  onTest
}: RoleBlockProps): JSX.Element {
  const spec = specOf(target)
  const known = isKnownSpec(target, groups)

  return (
    <>
      <div className="settings__row settings__row--form">
        <span className="settings__row-text">
          <span className="settings__row-label">{title}</span>
          <span className="settings__row-hint">{customSelected ? `${spec} — custom` : spec}</span>
          {test && (
            <span
              className={
                test.kind === 'busy' ? 'settings__row-hint' : hintClass(test.kind)
              }
            >
              {test.kind === 'busy' ? 'Testing connection…' : test.message}
            </span>
          )}
        </span>
        <span className="settings__row-action">
          <select
            className="settings__select"
            value={customSelected ? CUSTOM_CHOICE : spec}
            onChange={(e) => {
              const value = e.target.value
              if (value === CUSTOM_CHOICE) {
                // Keep the model id so the form below starts pre-filled.
                onPatch({ provider: 'custom', model: target.model || 'model' }, true)
              } else {
                const separator = value.indexOf('/')
                onPatch(
                  {
                    provider: value.slice(0, separator),
                    model: value.slice(separator + 1),
                    baseUrl: null,
                    apiKey: null
                  },
                  false
                )
              }
            }}
          >
            {/* Saved values outside the known list stay visible as the raw id. */}
            {!known && !customSelected && <option value={spec}>{spec}</option>}
            {customSelected && <option value={CUSTOM_CHOICE}>Custom…</option>}
            {groups.map((group) => (
              <optgroup key={group.provider} label={group.provider}>
                {group.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))}
            <option value={CUSTOM_CHOICE}>Custom…</option>
          </select>
          <button type="button" className="settings__button" onClick={onTest} disabled={test?.kind === 'busy'}>
            {test?.kind === 'busy' ? 'Testing…' : 'Test connection'}
          </button>
        </span>
      </div>
      {customSelected && (
        <div className="settings__fields">
          <label className="settings__field settings__field--wide">
            <span className="settings__field-label">Base URL (OpenAI-compatible)</span>
            <input
              className="settings__field-input"
              type="text"
              placeholder="http://127.0.0.1:8000/v1"
              value={target.baseUrl ?? ''}
              onChange={(e) => onPatch({ baseUrl: e.target.value }, true)}
            />
          </label>
          <label className="settings__field">
            <span className="settings__field-label">API key</span>
            <input
              className="settings__field-input"
              type="password"
              placeholder="environment key if empty"
              autoComplete="off"
              value={target.apiKey ?? ''}
              onChange={(e) => onPatch({ apiKey: e.target.value }, true)}
            />
          </label>
          <label className="settings__field">
            <span className="settings__field-label">Model id</span>
            <input
              className="settings__field-input"
              type="text"
              value={target.model}
              onChange={(e) => onPatch({ model: e.target.value }, true)}
            />
          </label>
        </div>
      )}
    </>
  )
}

type BackendBlockProps = {
  backend: CustomBackend
  index: number
  test: Feedback | undefined
  onPatch: (patch: Partial<CustomBackend>) => void
  onRemove: () => void
  onTest: () => void
}

function BackendBlock({ backend, index, test, onPatch, onRemove, onTest }: BackendBlockProps): JSX.Element {
  return (
    <div className="settings__fields">
      <div className="settings__fields-header">
        <span className="settings__field-label">
          Backend {index + 1}
          {backend.id ? ` — ${backend.id}` : ''}
        </span>
        <span className="settings__row-action">
          <button type="button" className="settings__button" onClick={onTest} disabled={test?.kind === 'busy'}>
            {test?.kind === 'busy' ? 'Testing…' : 'Test connection'}
          </button>
          <button type="button" className="settings__button" onClick={onRemove}>
            Remove
          </button>
        </span>
      </div>
      <label className="settings__field">
        <span className="settings__field-label">ID (provider name)</span>
        <input
          className="settings__field-input"
          type="text"
          placeholder="my-backend"
          value={backend.id}
          onChange={(e) => onPatch({ id: e.target.value })}
        />
      </label>
      <label className="settings__field">
        <span className="settings__field-label">Model</span>
        <input
          className="settings__field-input"
          type="text"
          value={backend.model}
          onChange={(e) => onPatch({ model: e.target.value })}
        />
      </label>
      <label className="settings__field settings__field--wide">
        <span className="settings__field-label">Base URL</span>
        <input
          className="settings__field-input"
          type="text"
          placeholder="https://host/v1"
          value={backend.baseUrl}
          onChange={(e) => onPatch({ baseUrl: e.target.value })}
        />
      </label>
      <label className="settings__field settings__field--wide">
        <span className="settings__field-label">API key</span>
        <input
          className="settings__field-input"
          type="password"
          placeholder="none"
          autoComplete="off"
          value={backend.apiKey}
          onChange={(e) => onPatch({ apiKey: e.target.value })}
        />
      </label>
      {test && (
        <span
          className={`settings__row-hint${test.kind === 'error' ? ' settings__row-hint--error' : test.kind === 'ok' ? ' settings__row-hint--ok' : ''}`}
        >
          {test.kind === 'busy' ? 'Testing connection…' : test.message}
        </span>
      )}
    </div>
  )
}

function ModelSection(): JSX.Element {
  // Optional chaining everywhere: a missing/disabled settings bridge must not
  // crash the modal — the section degrades to an inline error instead.
  const settingsApi = window.reconix?.settings
  const hasApi = Boolean(settingsApi)

  const [model, setModel] = useState<ModelSettings | null>(null)
  // (custom selection is now derived from the target spec + loaded groups)
  const [groups, setGroups] = useState<{ orchestrator: ModelGroup[]; domAnalyzer: ModelGroup[] }>({
    orchestrator: FALLBACK_ORCHESTRATOR_GROUPS,
    domAnalyzer: FALLBACK_DOM_ANALYZER_GROUPS
  })
  const [loadError, setLoadError] = useState<string | null>(null)
  // Retry counter reloads persisted settings without remounting the modal.
  const [retry, setRetry] = useState(0)
  const [tests, setTests] = useState<Record<string, Feedback>>({})
  const [saveStatus, setSaveStatus] = useState<Feedback | null>(null)

  // Load persisted settings on modal open. Never throws at call sites:
  // rejections land in loadError, cancellations are dropped.
  useEffect(() => {
    if (!settingsApi?.get) {
      setLoadError('Model settings are unavailable in this window.')
      return
    }
    let cancelled = false
    settingsApi
      .get()
      .then((next) => {
        if (cancelled) return
        setModel(next)
        setLoadError(null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(`Could not load model settings: ${(err as Error).message}`)
      })

    // Pull the live model catalog from OpenCode so the dropdowns reflect every
    // provider the user has authenticated, not a hand-maintained subset.
    if (settingsApi?.listModels) {
      settingsApi
        .listModels()
        .then((result) => {
          if (cancelled || !result?.providers) return
          const allGroups: ModelGroup[] = result.providers.map((provider) => ({
            provider: provider.id,
            options: provider.models.map((m) => ({ id: `${provider.id}/${m}`, label: m }))
          }))
          setGroups({
            orchestrator: allGroups.length ? allGroups : FALLBACK_ORCHESTRATOR_GROUPS,
            domAnalyzer: allGroups.length ? allGroups : FALLBACK_DOM_ANALYZER_GROUPS
          })
        })
        .catch((err: unknown) => {
          console.error('[settings] listModels failed:', err)
          // keep fallback groups; surface a hint in the load error only if
          // settings themselves also failed to load.
        })
    }

    // custom flags are derived in render from the target spec + loaded groups
    return () => {
      cancelled = true
    }
    // Remounts via App.tsx on open; `retry` powers the inline Retry button.
  }, [retry])

  const patchRole = (role: 'orchestrator' | 'domAnalyzer', patch: Partial<ModelTarget>): void => {
    if (!model) return
    if (role === 'orchestrator') setModel({ ...model, orchestrator: { ...model.orchestrator, ...patch } })
    else setModel({ ...model, domAnalyzer: { ...model.domAnalyzer, ...patch } })
  }

  const patchBackend = (index: number, patch: Partial<CustomBackend>): void => {
    if (!model) return
    setModel({
      ...model,
      customBackends: model.customBackends.map((b, i) => (i === index ? { ...b, ...patch } : b))
    })
  }

  const addBackend = (): void => {
    if (!model) return
    const number = model.customBackends.length + 1
    setModel({
      ...model,
      customBackends: [
        ...model.customBackends,
        { id: `my-backend-${number}`, baseUrl: '', apiKey: '', model: '' }
      ]
    })
  }

  const removeBackend = (index: number): void => {
    if (!model) return
    setModel({ ...model, customBackends: model.customBackends.filter((_, i) => i !== index) })
  }

  // Probe one target (role or ad-hoc form values) and report inline. Statuses
  // are keyed per row: 'orchestrator' | 'domAnalyzer' | 'backend:<index>'.
  const onTest = async (key: string, target: SettingsTestTarget): Promise<void> => {
    if (!settingsApi?.testConnection) return
    setTests((prev) => ({ ...prev, [key]: { kind: 'busy' } }))
    const result = await settingsApi.testConnection(target)
    const message = result.ok
      ? result.models && result.models.length > 0
        ? `Reachable — ${result.models.length} model${result.models.length === 1 ? '' : 's'} (first: ${result.models[0]})`
        : 'Reachable'
      : `Unreachable: ${result.error ?? 'unknown error'}`
    setTests((prev) => ({ ...prev, [key]: { kind: result.ok ? 'ok' : 'error', message } }))
  }

  const onSave = async (): Promise<void> => {
    if (!model || !settingsApi?.set) return
    setSaveStatus({ kind: 'busy' })
    setTests({}) // stale per-row results no longer match the draft
    const result = await settingsApi.set(model)
    if (result.ok) setSaveStatus({ kind: 'ok', message: 'Saved.' })
    else setSaveStatus({ kind: 'error', message: `Save failed: ${result.error ?? 'unknown error'}` })
  }

  if (loadError) {
    return (
      <section className="settings__section">
        <h3 className="settings__section-title">Model</h3>
        <div className="settings__row settings__row--form">
          <span className="settings__row-text">
            <span className={hintClass('error')}>{loadError}</span>
            {hasApi && <span className="settings__row-hint">Press Retry to read settings again.</span>}
          </span>
          {hasApi && (
            <button
              type="button"
              className="settings__button"
              onClick={() => {
                setLoadError(null)
                setRetry((n) => n + 1)
              }}
            >
              Retry
            </button>
          )}
        </div>
      </section>
    )
  }

  if (!model) {
    return (
      <section className="settings__section">
        <h3 className="settings__section-title">Model</h3>
        <div className="settings__row settings__row--form">
          <span className="settings__row-label">Loading model settings…</span>
        </div>
      </section>
    )
  }

  const draft = model

  return (
    <section className="settings__section">
      <h3 className="settings__section-title">Model</h3>

      <>
        <RoleBlock
          title="Orchestrator model"
          target={draft.orchestrator}
          groups={groups.orchestrator}
          customSelected={startsCustom(draft.orchestrator, groups.orchestrator) || draft.orchestrator.provider === 'custom'}
          test={tests.orchestrator}
          onPatch={(patch) => {
            patchRole('orchestrator', patch)
          }}
          onTest={() => void onTest('orchestrator', roleTestTarget(draft.orchestrator))}
        />

        <RoleBlock
          title="DOM-analyzer model"
          target={draft.domAnalyzer}
          groups={groups.domAnalyzer}
          customSelected={startsCustom(draft.domAnalyzer, groups.domAnalyzer) || draft.domAnalyzer.provider === 'custom'}
          test={tests.domAnalyzer}
          onPatch={(patch) => {
            patchRole('domAnalyzer', patch)
          }}
          onTest={() => void onTest('domAnalyzer', roleTestTarget(draft.domAnalyzer))}
        />

        <div className="settings__row settings__row--form">
          <span className="settings__row-text">
            <span className="settings__row-label">Reasoning effort</span>
            <span className="settings__row-hint">vLLM requires a server restart</span>
          </span>
          <select
            className="settings__select"
            value={draft.reasoning}
            onChange={(e) => setModel({ ...draft, reasoning: e.target.value as ReasoningEffort })}
          >
            {REASONING_LEVELS.map((level) => (
              <option key={level} value={level}>
                {REASONING_LABELS[level]}
              </option>
            ))}
          </select>
        </div>

        {draft.customBackends.map((backend, index) => (
            <BackendBlock
              key={`${backend.id || 'backend'}-${index}`}
              backend={backend}
              index={index}
              test={tests[`backend-${index}`]}
              onPatch={(patch) => patchBackend(index, patch)}
              onRemove={() => {
                removeBackend(index)
                setTests((prev) => {
                  const next = { ...prev }
                  delete next[`backend-${index}`]
                  return next
                })
              }}
              onTest={() => void onTest(`backend-${index}`, backendTestTarget(backend))}
            />
          ))}

          <div className="settings__row settings__row--form">
            <span className="settings__row-text">
              <span className="settings__row-label">Custom backends</span>
              <span className="settings__row-hint">OpenAI-compatible servers, mirrored into opencode.json</span>
            </span>
            <button type="button" className="settings__button" onClick={addBackend}>
              Add backend
            </button>
          </div>

          <div className="settings__row settings__row--form">
            <span className="settings__row-text">
              <span className="settings__row-label">Model settings</span>
              {saveStatus && saveStatus.kind !== 'busy' && (
                <span className={hintClass(saveStatus.kind)}>{saveStatus.message}</span>
              )}
              <span className="settings__row-hint">Takes effect on the next new chat</span>
            </span>
            <button
              type="button"
              className="settings__button"
              onClick={() => void onSave()}
              disabled={!hasApi || saveStatus?.kind === 'busy'}
            >
              {saveStatus?.kind === 'busy' ? 'Saving…' : 'Save'}
            </button>
          </div>
      </>
    </section>
  )
}

// ---------------------------------------------------------------------------
// External tools section — persisted allowlist for brokered binaries (§8.6).
// run_tool resolves this list (unioned with RECONIX_RUN_TOOL_ALLOWLIST), so the
// panel is the opt-in surface for executing external CLIs.
// ---------------------------------------------------------------------------

/** Binaries the repo's CLI wrappers already know how to drive. A scan only asks
 *  `which`/`where` whether each is on PATH — nothing is executed. */
const KNOWN_EXTERNAL_TOOLS: Array<{ name: string; label: string }> = [
  { name: 'nmap', label: 'nmap — port/service scan' },
  { name: 'nuclei', label: 'nuclei — template vuln scan' },
  { name: 'ffuf', label: 'ffuf — content discovery' },
  { name: 'subfinder', label: 'subfinder — subdomain enum' },
  { name: 'sqlmap', label: 'sqlmap — SQL injection' },
  { name: 'httpx', label: 'httpx — HTTP probe' },
  { name: 'katana', label: 'katana — crawler' },
  { name: 'gobuster', label: 'gobuster — directory brute force' }
]

/** Same rule as main's toolSettings.ts: a PATH-resolved name, never a path. */
const BINARY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

/** Known tools first, then any allowlisted/extras name the user added. */
function externalToolRows(
  allowlist: string[],
  extras: string[]
): Array<{ name: string; label: string }> {
  const rows = [...KNOWN_EXTERNAL_TOOLS]
  const seen = new Set(rows.map((row) => row.name.toLowerCase()))
  for (const name of [...allowlist, ...extras]) {
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ name, label: name })
  }
  return rows
}

function ExternalToolsSection(): JSX.Element {
  // Optional chaining: a missing bridge degrades to an inline error, never a crash.
  const api = window.reconix?.externalTools
  const hasApi = Boolean(api)

  const [config, setConfig] = useState<ExternalToolSettings | null>(null)
  const [extras, setExtras] = useState<string[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [probes, setProbes] = useState<Record<string, ExternalToolProbe>>({})
  const [scanStatus, setScanStatus] = useState<Feedback | null>(null)
  const [custom, setCustom] = useState('')
  const [customError, setCustomError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<Feedback | null>(null)

  useEffect(() => {
    if (!api?.get) {
      setLoadError('External tool settings are unavailable in this window.')
      return
    }
    let cancelled = false
    api
      .get()
      .then((next) => {
        if (cancelled) return
        setConfig(next)
        setProbes({})
        setLoadError(null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(`Could not load external tool settings: ${(err as Error).message}`)
      })
    return () => {
      cancelled = true
    }
  }, [retry])

  if (loadError) {
    return (
      <section className="settings__section">
        <h3 className="settings__section-title">External tools</h3>
        <div className="settings__row settings__row--form">
          <span className="settings__row-text">
            <span className={hintClass('error')}>{loadError}</span>
            {hasApi && <span className="settings__row-hint">Press Retry to read settings again.</span>}
          </span>
          {hasApi && (
            <button
              type="button"
              className="settings__button"
              onClick={() => {
                setLoadError(null)
                setRetry((n) => n + 1)
              }}
            >
              Retry
            </button>
          )}
        </div>
      </section>
    )
  }

  if (!config) {
    return (
      <section className="settings__section">
        <h3 className="settings__section-title">External tools</h3>
        <div className="settings__row settings__row--form">
          <span className="settings__row-label">Loading external tool settings…</span>
        </div>
      </section>
    )
  }

  const draft = config
  const rows = externalToolRows(draft.allowlist, extras)

  const onScan = async (): Promise<void> => {
    if (!api?.probe) return
    setScanning(true)
    setScanStatus(null)
    try {
      const results = await api.probe(rows.map((row) => row.name))
      const next: Record<string, ExternalToolProbe> = {}
      for (const result of results) next[result.name] = result
      setProbes(next)
      const installed = results.filter((result) => result.installed).length
      setScanStatus({
        kind: 'ok',
        message: `${installed} of ${results.length} binaries found on PATH`
      })
    } catch (err: unknown) {
      setScanStatus({ kind: 'error', message: `Scan failed: ${(err as Error).message}` })
    } finally {
      setScanning(false)
    }
  }

  const toggleTool = (name: string, enabled: boolean): void => {
    setSaveStatus(null)
    setConfig((current) => {
      if (!current) return current
      if (enabled) {
        if (current.allowlist.some((entry) => entry.toLowerCase() === name.toLowerCase())) return current
        return { ...current, allowlist: [...current.allowlist, name] }
      }
      return {
        ...current,
        allowlist: current.allowlist.filter((entry) => entry.toLowerCase() !== name.toLowerCase())
      }
    })
  }

  const addCustom = (): void => {
    const name = custom.trim()
    if (!BINARY_NAME_RE.test(name)) {
      setCustomError('Use a binary name only — letters, digits, ".", "_", "+", "-" (no paths).')
      return
    }
    if (rows.some((row) => row.name.toLowerCase() === name.toLowerCase())) {
      setCustomError(`"${name}" is already listed.`)
      return
    }
    setCustom('')
    setCustomError(null)
    setSaveStatus(null)
    setExtras((current) => [...current, name])
    setConfig((current) =>
      current ? { ...current, allowlist: [...current.allowlist, name] } : current
    )
  }

  const onSave = async (): Promise<void> => {
    if (!api?.set) return
    setSaveStatus({ kind: 'busy' })
    const result = await api.set(draft)
    if (result.ok) setSaveStatus({ kind: 'ok', message: 'Saved.' })
    else setSaveStatus({ kind: 'error', message: `Save failed: ${result.error ?? 'unknown error'}` })
  }

  return (
    <section className="settings__section">
      <h3 className="settings__section-title">External tools</h3>

      <div className="settings__row settings__row--form">
        <span className="settings__row-text">
          <span className="settings__row-label">Installed binaries</span>
          {scanStatus && scanStatus.kind !== 'busy' && (
            <span className={hintClass(scanStatus.kind)}>{scanStatus.message}</span>
          )}
          <span className="settings__row-hint">
            Scans PATH only; binaries are never run to detect them.
          </span>
        </span>
        <button
          type="button"
          className="settings__button"
          onClick={() => void onScan()}
          disabled={!hasApi || scanning}
        >
          {scanning ? 'Scanning…' : 'Scan for tools'}
        </button>
      </div>

      {rows.map((row) => {
        const probe = probes[row.name]
        const enabled = draft.allowlist.some(
          (entry) => entry.toLowerCase() === row.name.toLowerCase()
        )
        return (
          <div key={row.name} className="settings__row settings__row--form">
            <span className="settings__row-text">
              <span className="settings__row-label">{row.label}</span>
              <span className="settings__row-hint">
                {probe
                  ? probe.installed
                    ? (probe.resolvedPath ?? 'installed')
                    : 'not found on PATH'
                  : enabled
                    ? 'allowed — not scanned yet'
                    : 'not allowed'}
              </span>
            </span>
            <span className="settings__row-action">
              {probe && (
                <span className={`settings__pill settings__pill--${probe.installed ? 'ok' : 'missing'}`}>
                  {probe.installed ? 'installed' : 'missing'}
                </span>
              )}
              <input
                type="checkbox"
                aria-label={`Allow ${row.name}`}
                checked={enabled}
                onChange={(e) => toggleTool(row.name, e.target.checked)}
              />
            </span>
          </div>
        )
      })}

      <div className="settings__row settings__row--form">
        <span className="settings__row-text">
          <span className="settings__row-label">Custom binary</span>
          {customError ? (
            <span className={hintClass('error')}>{customError}</span>
          ) : (
            <span className="settings__row-hint">Any other PATH binary name</span>
          )}
        </span>
        <span className="settings__row-action">
          <input
            className="settings__select"
            type="text"
            placeholder="e.g. whatweb"
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value)
              setCustomError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addCustom()
              }
            }}
          />
          <button type="button" className="settings__button" onClick={addCustom}>
            Add
          </button>
        </span>
      </div>

      <div className="settings__row settings__row--form">
        <span className="settings__row-text">
          <span className="settings__row-label">Allowlist</span>
          <span className="settings__row-hint">
            Allowlisted binaries run with your user privileges: argv-only, no shell, hard
            time/output caps. Only add tools you trust. RECONIX_RUN_TOOL_ALLOWLIST is merged in
            at run time and can’t be removed here.
          </span>
          {saveStatus && saveStatus.kind !== 'busy' && (
            <span className={hintClass(saveStatus.kind)}>{saveStatus.message}</span>
          )}
        </span>
        <button
          type="button"
          className="settings__button"
          onClick={() => void onSave()}
          disabled={!hasApi || saveStatus?.kind === 'busy'}
        >
          {saveStatus?.kind === 'busy' ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  )
}

type ToggleRowProps = {
  label: string
  hint?: string
  checked: boolean
  onChange: (value: boolean) => void
}

function ToggleRow({ label, hint, checked, onChange }: ToggleRowProps): JSX.Element {
  return (
    <label className="settings__row">
      <span className="settings__row-text">
        <span className="settings__row-label">{label}</span>
        {hint && <span className="settings__row-hint">{hint}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

function SettingsModal({ settings, onClose }: SettingsModalProps): JSX.Element {
  const { settings: values, set } = settings

  // About / Updates: version comes from main (window.reconix.app.version), and
  // the check is a plain IPC round-trip that never throws — failures come back
  // as { ok: false, error } and are shown inline.
  const version = window.reconix.app?.version || 'unknown'
  const [checking, setChecking] = useState(false)
  const [updateStatus, setUpdateStatus] = useState('')

  const onCheckForUpdates = async (): Promise<void> => {
    setChecking(true)
    setUpdateStatus('Checking for updates…')
    const result = await window.reconix.app.checkForUpdates()
    setChecking(false)
    if (!result.ok) {
      setUpdateStatus(`Update check failed: ${result.error ?? 'unknown error'}`)
    } else if (result.version) {
      setUpdateStatus(`Version ${result.version} is downloading in the background.`)
    } else {
      setUpdateStatus('You’re on the latest version.')
    }
  }

  // Esc closes, matching the native-feel of the rest of the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="settings__header">
          <h2 className="settings__title">Settings</h2>
          <button type="button" className="settings__close" aria-label="Close settings" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="settings__body">
          <section className="settings__section">
            <h3 className="settings__section-title">General</h3>
            <ToggleRow
              label="Open sitemap on launch"
              hint="Show the sidebar when the app starts"
              checked={values.openSidebarOnLaunch}
              onChange={(v) => set('openSidebarOnLaunch', v)}
            />
            <ToggleRow
              label="Open Copilot on launch"
              hint="Show the Copilot panel when the app starts"
              checked={values.openCopilotOnLaunch}
              onChange={(v) => set('openCopilotOnLaunch', v)}
            />
          </section>

          <ModelSection />

          <ExternalToolsSection />

          <section className="settings__section">
            <h3 className="settings__section-title">About</h3>
            <div className="settings__row">
              <span className="settings__row-text">
                <span className="settings__row-label">Reconix {version}</span>
                {updateStatus && <span className="settings__row-hint">{updateStatus}</span>}
              </span>
              <button
                type="button"
                className="settings__button"
                onClick={() => void onCheckForUpdates()}
                disabled={checking}
              >
                {checking ? 'Checking…' : 'Check for updates'}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

export default SettingsModal

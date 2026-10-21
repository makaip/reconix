import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALLOWLIST_ENV_VAR,
  DEFAULT_EXTERNAL_TOOL_SETTINGS,
  load,
  loadExternalToolSettings,
  invalidateExternalToolSettingsCache,
  parseAllowlist,
  probeExternalTools,
  resolveAllowlist,
  save,
  setExternalToolSettingsPath,
  validateExternalToolSettings,
  type ExternalToolSettings
} from './toolSettings'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'reconix-tools-'))

const configured: ExternalToolSettings = {
  allowlist: ['nmap', 'nuclei'],
  defaultTimeoutMs: 120_000,
  maxOutputBytes: 2_000_000
}

const previousEnv = process.env[ALLOWLIST_ENV_VAR]

afterEach(() => {
  if (previousEnv === undefined) delete process.env[ALLOWLIST_ENV_VAR]
  else process.env[ALLOWLIST_ENV_VAR] = previousEnv
  invalidateExternalToolSettingsCache()
  setExternalToolSettingsPath('')
})

describe('toolSettings', () => {
  it('denies everything by default when the file is missing', async () => {
    expect(await load(tempDir())).toEqual(DEFAULT_EXTERNAL_TOOL_SETTINGS)
    expect(DEFAULT_EXTERNAL_TOOL_SETTINGS.allowlist).toEqual([])
  })

  it('falls back to defaults on corrupt JSON instead of throwing', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'external-tool-settings.json'), '{ not json')
    expect(await load(dir)).toEqual(DEFAULT_EXTERNAL_TOOL_SETTINGS)
  })

  it('falls back to defaults on schema-invalid content', async () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'external-tool-settings.json'),
      JSON.stringify({ ...configured, defaultTimeoutMs: 1 })
    )
    expect(await load(dir)).toEqual(DEFAULT_EXTERNAL_TOOL_SETTINGS)
  })

  it('round-trips saved settings', async () => {
    const dir = tempDir()
    expect((await save(dir, configured)).ok).toBe(true)
    const onDisk = JSON.parse(
      readFileSync(join(dir, 'external-tool-settings.json'), 'utf8')
    ) as ExternalToolSettings
    expect(onDisk).toEqual(configured)
    expect(await load(dir)).toEqual(configured)
  })

  it('rejects paths in the allowlist (names only)', () => {
    for (const entry of ['/usr/bin/nmap', '../nmap', 'nmap --script', 'n m']) {
      const result = validateExternalToolSettings({ allowlist: [entry] })
      expect(result.ok).toBe(false)
    }
  })

  it('de-dupes allowlist entries and strips unknown fields', () => {
    const result = validateExternalToolSettings({ ...configured, allowlist: ['nmap', 'NMAP', 'ffuf'] })
    expect(result.ok).toBe(true)
    expect(result.settings?.allowlist).toEqual(['nmap', 'ffuf'])
  })

  it('parses comma-separated env lists, dropping invalid entries', () => {
    expect(parseAllowlist(' nmap , ffuf,,/bin/sh ,nuclei ')).toEqual(['nmap', 'ffuf', 'nuclei'])
    expect(parseAllowlist(undefined)).toEqual([])
  })

  it('unions the persisted allowlist with the env var', async () => {
    const dir = tempDir()
    await save(dir, configured)
    process.env[ALLOWLIST_ENV_VAR] = 'ffuf,nuclei'
    expect(await resolveAllowlist(dir)).toEqual(['nmap', 'nuclei', 'ffuf'])
  })

  it('resolves env-only when no userData path is configured', async () => {
    setExternalToolSettingsPath('')
    process.env[ALLOWLIST_ENV_VAR] = 'nmap'
    expect(await resolveAllowlist()).toEqual(['nmap'])
  })

  it('caches per userData path until invalidated', async () => {
    const dir = tempDir()
    await save(dir, { ...configured, allowlist: ['nmap'] })

    // A write behind the cache's back is only observed by the uncached reader…
    writeFileSync(
      join(dir, 'external-tool-settings.json'),
      JSON.stringify({ ...configured, allowlist: ['ffuf'] })
    )
    expect((await load(dir)).allowlist).toEqual(['ffuf'])
    // …while the cached reader still serves the saved value.
    expect((await loadExternalToolSettings(dir)).allowlist).toEqual(['nmap'])
    invalidateExternalToolSettingsCache(dir)
    expect((await loadExternalToolSettings(dir)).allowlist).toEqual(['ffuf'])
  })

  it('probes only valid names and reports missing binaries without throwing', async () => {
    const results = await probeExternalTools(['definitely-not-a-real-binary-xyz', '/bin/sh'])
    expect(results.map((r) => r.name)).toEqual(['definitely-not-a-real-binary-xyz'])
    expect(results[0]).toEqual({ name: 'definitely-not-a-real-binary-xyz', installed: false })
  })

  it('finds a binary that is certainly on PATH (env `/bin/sh` name sh)', async () => {
    const [result] = await probeExternalTools(['sh'])
    if (process.platform === 'win32') return // `sh` is not guaranteed on Windows
    expect(result.installed).toBe(true)
    expect(result.resolvedPath).toBeTruthy()
  })
})

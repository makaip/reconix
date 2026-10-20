// Importing the copilot pulls in Electron-backed modules; stub the handful of
// runtime APIs it touches so this stays a plain Node unit test.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.RECONIX_TEST_USERDATA ?? '',
    getAppPath: () => process.cwd()
  },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
  net: {}
}))

const { getDomAnalyzerModel, getOrchestratorModel } = await import('./copilot')
const { invalidateModelSettingsCache } = await import('./modelSettings')

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'reconix-copilot-'))

function writeSettings(dir: string, settings: unknown): void {
  writeFileSync(join(dir, 'model-settings.json'), JSON.stringify(settings))
}

describe('copilot model resolution', () => {
  beforeEach(() => {
    invalidateModelSettingsCache()
  })

  it('returns the configured orchestrator model', async () => {
    const dir = tempDir()
    process.env.RECONIX_TEST_USERDATA = dir
    writeSettings(dir, {
      orchestrator: { provider: 'gemini', model: 'gemini-2.5-pro' },
      domAnalyzer: { provider: 'opencode', model: 'grok-code' },
      reasoning: 'medium',
      customBackends: []
    })

    expect(await getOrchestratorModel()).toBe('gemini/gemini-2.5-pro')
    expect(await getDomAnalyzerModel()).toBe('opencode/grok-code')
  })

  it('returns the legacy hardcoded model when no settings file exists', async () => {
    process.env.RECONIX_TEST_USERDATA = tempDir()
    expect(await getOrchestratorModel()).toBe('vllm-orchestrator/orchestrator-model')
  })

  it('re-reads after the cache is invalidated (settings:set path)', async () => {
    const dir = tempDir()
    process.env.RECONIX_TEST_USERDATA = dir
    writeSettings(dir, {
      orchestrator: { provider: 'vllm-orchestrator', model: 'orchestrator-model' },
      domAnalyzer: { provider: 'opencode', model: 'grok-code' },
      reasoning: 'low',
      customBackends: []
    })
    expect(await getOrchestratorModel()).toBe('vllm-orchestrator/orchestrator-model')

    writeSettings(dir, {
      orchestrator: { provider: 'openrouter', model: 'dolphin3-mistral-24b' },
      domAnalyzer: { provider: 'opencode', model: 'grok-code' },
      reasoning: 'low',
      customBackends: []
    })
    // Still cached until the setter invalidates it.
    expect(await getOrchestratorModel()).toBe('vllm-orchestrator/orchestrator-model')

    invalidateModelSettingsCache()
    expect(await getOrchestratorModel()).toBe('openrouter/dolphin3-mistral-24b')
  })
})

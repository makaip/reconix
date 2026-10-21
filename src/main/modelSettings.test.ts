import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_MODEL_SETTINGS,
  getModelSpec,
  load,
  save,
  testConnection,
  validateModelSettings,
  type ModelSettings
} from './modelSettings'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'reconix-settings-'))

const configured: ModelSettings = {
  orchestrator: { provider: 'gemini', model: 'gemini-2.5-pro' },
  domAnalyzer: { provider: 'opencode', model: 'glm-5.3-flash-free' },
  reasoning: 'high',
  customBackends: [
    { id: 'my-openai', baseUrl: 'https://api.example.test/v1', apiKey: 'sk-secret', model: 'gpt-4o' }
  ]
}

describe('modelSettings', () => {
  it('falls back to the previous hardcoded defaults when the file is missing', async () => {
    const settings = await load(tempDir())
    expect(settings).toEqual(DEFAULT_MODEL_SETTINGS)
    expect(getModelSpec(settings, 'orchestrator')).toBe('vllm-orchestrator/orchestrator-model')
    expect(getModelSpec(settings, 'domAnalyzer')).toBe('opencode/glm-5.3-flash-free')
  })

  it('falls back to defaults on corrupt JSON instead of throwing', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'model-settings.json'), '{ not json')
    expect(await load(dir)).toEqual(DEFAULT_MODEL_SETTINGS)
  })

  it('falls back to defaults on schema-invalid content', async () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'model-settings.json'),
      JSON.stringify({ ...configured, reasoning: 'ultra' })
    )
    expect(await load(dir)).toEqual(DEFAULT_MODEL_SETTINGS)
  })

  it('round-trips saved settings', async () => {
    const dir = tempDir()
    const result = await save(dir, configured)
    expect(result.ok).toBe(true)

    const onDisk = JSON.parse(readFileSync(join(dir, 'model-settings.json'), 'utf8')) as ModelSettings
    expect(onDisk).toEqual(configured)
    expect(await load(dir)).toEqual(configured)
  })

  it('creates the userData dir when saving into a fresh path', async () => {
    const dir = join(tempDir(), 'nested', 'userData')
    expect((await save(dir, configured)).ok).toBe(true)
    expect(await load(dir)).toEqual(configured)
  })

  it('rejects non-http(s) custom backend URLs (no file:/data:)', async () => {
    const dir = tempDir()
    const result = await save(dir, {
      ...configured,
      customBackends: [{ id: 'evil', baseUrl: 'file:///etc/passwd', apiKey: '', model: 'x' }]
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/http\(s\)/)
  })

  it('rejects empty model ids and duplicate backend ids', () => {
    expect(validateModelSettings({ ...configured, orchestrator: { provider: 'gemini', model: ' ' } }).ok).toBe(
      false
    )
    expect(
      validateModelSettings({
        ...configured,
        customBackends: [configured.customBackends[0], configured.customBackends[0]]
      }).ok
    ).toBe(false)
  })

  it('accepts explicit per-target baseUrl/apiKey overrides', () => {
    const result = validateModelSettings({
      ...configured,
      orchestrator: {
        provider: 'vllm-orchestrator',
        model: 'orchestrator-model',
        baseUrl: 'http://127.0.0.1:8000/v1',
        apiKey: 'local'
      }
    })
    expect(result.ok).toBe(true)
    expect(result.settings?.orchestrator.baseUrl).toBe('http://127.0.0.1:8000/v1')
  })
})

describe('testConnection', () => {
  it('probes GET /models and returns the advertised ids', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as typeof fetch

    const result = await testConnection(configured, 'orchestrator', fetchImpl)
    expect(result).toEqual({ ok: true, models: ['gpt-4o', 'gpt-4o-mini'] })
    // gemini's known endpoint, normalized without a trailing slash
    expect(calls[0]).toBe('https://generativelanguage.googleapis.com/v1beta/openai/models')
  })

  it('uses a custom backend entry for its provider id', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    const result = await testConnection(configured, { provider: 'my-openai', model: 'gpt-4o' }, fetchImpl)
    expect(result.ok).toBe(true)
    expect(calls[0]).toBe('https://api.example.test/v1/models')
  })

  it('reports a bad status as an error', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as typeof fetch
    const result = await testConnection(configured, 'orchestrator', fetchImpl)
    expect(result).toEqual({ ok: false, error: 'GET /models returned HTTP 401' })
  })

  it('falls back to a tiny chat completion when /models is missing', async () => {
    const paths: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      paths.push(new URL(String(url)).pathname)
      return new Response('{}', { status: paths.length === 1 ? 404 : 200 })
    }) as typeof fetch

    const result = await testConnection(configured, { provider: 'my-openai', model: 'gpt-4o' }, fetchImpl)
    expect(result).toEqual({ ok: true })
    expect(paths).toEqual(['/v1/models', '/v1/chat/completions'])
  })

  it('fails cleanly when no endpoint is configured', async () => {
    const fetchImpl = (async () => new Response('', { status: 200 })) as typeof fetch
    const result = await testConnection(
      { ...configured, orchestrator: { provider: 'unknown-provider', model: 'x' } },
      'orchestrator',
      fetchImpl
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/No http\(s\) endpoint/)
  })
})

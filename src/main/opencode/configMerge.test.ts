import { describe, expect, it } from 'vitest'
import { mergeConfig } from './configMerge'

describe('mergeConfig', () => {
  it('preserves keys only the user had (e.g. plugins)', () => {
    const repo = { model: 'gemini/gemini-flash-lite-latest' }
    const existing = { plugins: ['oh-my-opencode-slim'], model: 'opencode/beam-free' }

    expect(mergeConfig(repo, existing)).toEqual({
      plugins: ['oh-my-opencode-slim'],
      model: 'gemini/gemini-flash-lite-latest'
    })
  })

  it('returns the repo config unchanged when there is no existing config', () => {
    const repo = { default_agent: 'pentest-orchestrator' }
    expect(mergeConfig(repo)).toEqual(repo)
    expect(mergeConfig(repo, undefined)).toEqual(repo)
  })

  it('deep-merges nested objects with repo winning at leaves', () => {
    const repo = {
      providers: { gemini: { name: 'Google Gemini (direct)' } }
    }
    const existing = {
      providers: { gemini: { name: 'old', settings: { apiKey: 'x' } }, navigator: { name: 'NaviGator' } }
    }

    expect(mergeConfig(repo, existing)).toEqual({
      providers: {
        gemini: { name: 'Google Gemini (direct)', settings: { apiKey: 'x' } },
        navigator: { name: 'NaviGator' }
      }
    })
  })

  it('replaces arrays rather than concatenating them', () => {
    const repo = { permissions: ['repo-rule'] }
    const existing = { permissions: ['user-rule'] }
    expect(mergeConfig(repo, existing)).toEqual({ permissions: ['repo-rule'] })
  })

  it('does not treat arrays or null as mergeable objects', () => {
    const repo = { mcp: { servers: { reconix: { url: 'a' } } } }
    const existing = { mcp: { list: [1, 2], nothing: null } }
    expect(mergeConfig(repo, existing)).toEqual({
      mcp: { list: [1, 2], nothing: null, servers: { reconix: { url: 'a' } } }
    })
  })
})

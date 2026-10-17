import { describe, expect, it } from 'vitest'
import { invokeTool, ToolInputError } from '../shared/tools'
import { detectSecretsTool } from './detectSecrets'

/** Assert a hit of `type` exists and the full secret is NOT in the output. */
function expectRedactedHit(body: string, type: string, secret: string) {
  const result = invokeTool(detectSecretsTool, { body })
  const hit = result.hits.find((h) => h.type === type)
  expect(hit, `expected a '${type}' hit`).toBeDefined()
  expect(hit!.offset).toBeGreaterThanOrEqual(0)
  // Redaction is mandatory: the full secret must never appear verbatim.
  expect(JSON.stringify(result)).not.toContain(secret)
  return hit!
}

describe('detect_secrets', () => {
  it('detects AWS access key id', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE'
    const hit = expectRedactedHit(`key=${secret}`, 'aws-access-key-id', secret)
    expect(hit.confidence).toBe('high')
  })

  it('detects AWS secret-key-shaped 40-char high-entropy string', () => {
    const secret = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN' // 40 unique chars
    expect(secret.length).toBe(40)
    const hit = expectRedactedHit(`  ${secret}  `, 'aws-secret-access-key', secret)
    expect(hit.confidence).toBe('medium')
  })

  it('detects Google API key', () => {
    const secret = 'AIza' + 'B'.repeat(35)
    expectRedactedHit(`url?key=${secret}`, 'google-api-key', secret)
  })

  it('detects Slack token', () => {
    const secret = 'xoxb-123456789012-abcdefABCDEF'
    expectRedactedHit(`token: ${secret}`, 'slack-token', secret)
  })

  it('detects GitHub token', () => {
    const secret = 'ghp_' + 'a'.repeat(36)
    expectRedactedHit(`Authorization ${secret}`, 'github-token', secret)
  })

  it('detects GitHub fine-grained PAT', () => {
    const secret = 'github_pat_' + 'A'.repeat(30)
    expectRedactedHit(`${secret}`, 'github-token', secret)
  })

  it('detects JWT', () => {
    const secret =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expectRedactedHit(`jwt=${secret}`, 'jwt', secret)
  })

  it('detects private key header', () => {
    const result = invokeTool(detectSecretsTool, {
      body: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...'
    })
    expect(result.hits.some((h) => h.type === 'private-key')).toBe(true)
  })

  it('detects bearer token', () => {
    const secret = 'abcdef1234567890ABCDEF'
    const hit = expectRedactedHit(
      `Authorization: Bearer ${secret}`,
      'bearer-token',
      secret
    )
    expect(hit.confidence).toBe('medium')
  })

  it('detects basic auth', () => {
    const secret = 'dXNlcjpzdXBlcnNlY3JldA==' // base64 of user:supersecret
    expectRedactedHit(`Authorization: Basic ${secret}`, 'basic-auth', secret)
  })

  it('detects generic credential assignment', () => {
    const secret = 's3cr3tValue1234'
    const hit = expectRedactedHit(`api_key = "${secret}"`, 'credential-assignment', secret)
    expect(hit.confidence).toBe('low')
  })

  it('redacts to first/last 4 chars', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE'
    const result = invokeTool(detectSecretsTool, { body: secret })
    const hit = result.hits.find((h) => h.type === 'aws-access-key-id')!
    expect(hit.redacted).toBe('AKIA...MPLE')
  })

  it('fully masks short secrets so nothing leaks', () => {
    const result = invokeTool(detectSecretsTool, { body: 'password=abcdef' })
    const hit = result.hits.find((h) => h.type === 'credential-assignment')
    if (hit) {
      expect(hit.redacted).not.toContain('abcdef')
    }
  })

  it('de-dupes identical hits', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE'
    const result = invokeTool(detectSecretsTool, { body: secret })
    const akiaHits = result.hits.filter((h) => h.type === 'aws-access-key-id')
    expect(akiaHits.length).toBe(1)
  })

  it('clean body yields zero hits', () => {
    const result = invokeTool(detectSecretsTool, {
      body: 'the quick brown fox jumps over the lazy dog repeatedly today'
    })
    expect(result.count).toBe(0)
    expect(result.hits).toEqual([])
  })

  it('count matches hits length', () => {
    const result = invokeTool(detectSecretsTool, {
      body: 'key=AKIAIOSFODNN7EXAMPLE and api_key = "s3cr3tValue1234"'
    })
    expect(result.count).toBe(result.hits.length)
    expect(result.count).toBeGreaterThanOrEqual(2)
  })

  it('rejects malformed/hostile input: wrong type', () => {
    expect(() => invokeTool(detectSecretsTool, { body: 42 })).toThrow(ToolInputError)
  })

  it('rejects hostile input: missing body', () => {
    expect(() => invokeTool(detectSecretsTool, {})).toThrow(ToolInputError)
  })

  it('rejects hostile input: non-object', () => {
    expect(() => invokeTool(detectSecretsTool, null)).toThrow(ToolInputError)
    expect(() => invokeTool(detectSecretsTool, [])).toThrow(ToolInputError)
  })

  it('rejects hostile input: oversized body', () => {
    expect(() => invokeTool(detectSecretsTool, { body: 'a'.repeat(5_000_001) })).toThrow(
      ToolInputError
    )
  })
})

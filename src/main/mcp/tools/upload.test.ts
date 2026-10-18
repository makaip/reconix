import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { uploadFiles } from './upload'
import { buildMcpServer } from '../index'
import type { ToolContext } from '../tool'
import type { AuditLogger } from '../audit'

const input = (file: Record<string, unknown>) => ({ selector: '#upload', files: [file] })

describe('upload_files', () => {
  it('preserves UTF-8, binary, and empty content', () => {
    const parsed = uploadFiles.parse({ selector: '#upload', files: [
      { name: 'hello.txt', content: 'Hello 🌍', mimeType: 'text/plain' },
      { name: 'binary.bin', content: 'AP+A', encoding: 'base64' },
      { name: 'empty.txt', content: '' }
    ] })
    expect(Buffer.from(parsed.files[0].base64, 'base64').toString()).toBe('Hello 🌍')
    expect(Buffer.from(parsed.files[1].base64, 'base64')).toEqual(Buffer.from([0, 255, 128]))
    expect(parsed.files[2].base64).toBe('')
  })

  it.each([
    { selector: '#upload', files: [] },
    { selector: '#upload', files: Array(11).fill({ name: 'x', content: '' }) },
    input({ name: '../secret', content: '' }),
    input({ name: 'a\\secret', content: '' }),
    input({ name: 'a\n.txt', content: '' }),
    input({ name: 'x', content: 'not base64!', encoding: 'base64' }),
    input({ name: 'x', content: '', encoding: 'hex' }),
    input({ name: 'x' }),
    input({ name: 'x', content: 'a'.repeat(1024 * 1024 + 1) }),
    { selector: '#upload', files: Array(2).fill({ name: 'x', content: 'a'.repeat(600_000) }) }
  ])('rejects invalid or oversized input %#', (raw) => {
    expect(() => uploadFiles.parse(raw)).toThrow()
  })

  it('surfaces page-side validation failures', async () => {
    const evaluate = vi.fn().mockResolvedValue(JSON.stringify({ error: 'File input is disabled.' }))
    await expect(uploadFiles.execute(uploadFiles.parse(input({ name: 'a', content: 'x' })),
      { cdp: { evaluate } } as unknown as ToolContext)).rejects.toThrow('File input is disabled')
  })

  it('advertises upload as mutating on both surfaces and requires approval in OpenCode', () => {
    for (const surface of ['all', 'mvp'] as const) {
      const server = buildMcpServer({ surface, context: {} as ToolContext, audit: {} as AuditLogger })
      expect(server.listTools().find((tool) => tool.name === 'upload_files')?.riskTier).toBe('M')
      server.setEnabledTools([])
      expect(server.listTools()).toEqual([])
    }
    const config = JSON.parse(readFileSync('opencode.json', 'utf8'))
    expect(config.permissions).toContainEqual({ action: 'reconix_upload_files', resource: '*', effect: 'ask' })
  })
})

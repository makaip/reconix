import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { interactionTools } from './interaction'
import { ToolInputError } from '../errors'
import type { ToolContext } from '../tool'

const fill = interactionTools.find((tool) => tool.name === 'fill')!

function page(type: string) {
  let writes = 0
  const events: string[] = []
  const input = {
    tagName: 'INPUT', type, value: '',
    dispatchEvent: (event: { type: string }) => events.push(event.type)
  }
  let value = ''
  Object.defineProperty(input, 'value', {
    get: () => value,
    set: (next: string) => {
      writes++
      if (type === 'file' && next !== '') throw new Error('Browser forbids assigning a filename')
      value = next
    }
  })
  const ctx = { cdp: { evaluate: async (expression: string) => JSON.stringify(runInNewContext(expression, {
    document: { querySelector: () => input },
    Event: class { constructor(public type: string) {} }
  })) } } as unknown as ToolContext
  return { ctx, input, events, writes: () => writes }
}

describe('fill file input handling', () => {
  it('returns actionable non-retriable guidance before assigning a filename', async () => {
    const fixture = page('file')
    const action = fill.execute({ selector: '#upload', value: 'test.txt' }, fixture.ctx)
    await expect(action).rejects.toBeInstanceOf(ToolInputError)
    await expect(action).rejects.toThrow('approved multipart request')
    expect(fixture.writes()).toBe(0)
    expect(fixture.events).toEqual([])
  })

  it('still fills text inputs and dispatches input', async () => {
    const fixture = page('text')
    await expect(fill.execute({ selector: '#name', value: 'A name' }, fixture.ctx)).resolves.toEqual({ ok: true })
    expect(fixture.input.value).toBe('A name')
    expect(fixture.events).toEqual(['input'])
  })

  it('allows clearing a file input', async () => {
    const fixture = page('file')
    await expect(fill.execute({ selector: '#upload', value: '' }, fixture.ctx)).resolves.toEqual({ ok: true })
    expect(fixture.writes()).toBe(1)
  })
})

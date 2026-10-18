import { describe, expect, it } from 'vitest'
import { ThinkingStream } from './thinking'

describe('Qwen inline thinking', () => {
  it('separates reasoning and answer with delimiters split at every possible boundary', () => {
    const source = '<think>inspect the form</think>Here is the answer.'
    for (let split = 1; split < source.length; split++) {
      const parser = new ThinkingStream()
      const parts = [...parser.push('m', source.slice(0, split)), ...parser.push('m', source.slice(split)), ...parser.finish()]
      expect(parts.filter(p => p.reasoning).map(p => p.text).join('')).toBe('inspect the form')
      expect(parts.filter(p => !p.reasoning).map(p => p.text).join('')).toBe('Here is the answer.')
    }
  })

  it('streams token-sized chunks while leaving literal tags in ordinary answers alone', () => {
    const parser = new ThinkingStream()
    const parts = [...'An example uses <think>literal</think>.'].flatMap(c => parser.push('m', c))
    expect(parts.some(p => p.reasoning)).toBe(false)
    expect(parts.map(p => p.text).join('')).toBe('An example uses <think>literal</think>.')
  })

  it('isolates sessions and flushes interrupted output', () => {
    const parser = new ThinkingStream()
    parser.push('parent', '<think>inspect</th', 'parent')
    parser.push('child', '<thi', 'child')
    expect(parser.finish('parent')).toEqual([{ message: 'parent', reasoning: true, text: '</th' }])
    expect(parser.push('child', 'nk>child</think>done', 'child')).toEqual([
      { reasoning: true, text: 'child' }, { reasoning: false, text: 'done' }
    ])
  })

  it('keeps a completed answer visible when the deployed variant omits the closing tag', () => {
    const parser = new ThinkingStream()
    parser.push('m', '<think>\n\nThe server received the file.', 's')
    expect(parser.finish('s', true)).toEqual([{ message: 'm', reasoning: false, text: '\n\nThe server received the file.' }])
  })
})

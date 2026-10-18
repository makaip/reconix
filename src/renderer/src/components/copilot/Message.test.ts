import { describe, expect, it } from 'vitest'
import { parseEmbeddedQuestion, visibleTranscriptParts } from './Message'
import type { TranscriptPart } from './transcript'
import { isBrowserTool } from './transcript'

describe('parseEmbeddedQuestion', () => {
  it('turns a serialized question tool call into a native question model', () => {
    const result = parseEmbeddedQuestion(
      JSON.stringify({
        name: 'question',
        arguments: {
          questions: [
            {
              header: 'Rate Limit Exceeded',
              question: 'Retry later or use another approach?',
              options: [
                { label: 'Retry later', description: 'Wait for the quota to reset.' },
                { label: 'Try another approach', description: 'Continue without the specialist.' }
              ]
            }
          ]
        }
      })
    )

    expect(result).toEqual({
      header: 'Rate Limit Exceeded',
      question: 'Retry later or use another approach?',
      options: [
        { label: 'Retry later', description: 'Wait for the quota to reset.' },
        { label: 'Try another approach', description: 'Continue without the specialist.' }
      ]
    })
  })

  it('does not reinterpret ordinary JSON as a question', () => {
    expect(parseEmbeddedQuestion('{"vulnerable":false}')).toBeNull()
    expect(parseEmbeddedQuestion('not json')).toBeNull()
  })
})

describe('visibleTranscriptParts', () => {
  it('hides delegation and rejoins the surrounding answer in order', () => {
    const parts: TranscriptPart[] = [
      { kind: 'text', text: 'First. ' },
      {
        kind: 'tool',
        callId: 'delegate-1',
        tool: 'task',
        params: { agent: 'evaluator' },
        riskTier: 'R',
        status: 'ok',
        isSubagent: true
      },
      { kind: 'text', text: 'Second.' }
    ]

    expect(visibleTranscriptParts(parts)).toEqual([{ kind: 'text', text: 'First. Second.' }])
  })

  it('keeps ordinary tools as explicit ordering boundaries', () => {
    const tool: TranscriptPart = {
      kind: 'tool',
      callId: 'inspect-1',
      tool: 'page_info',
      params: {},
      riskTier: 'R',
      status: 'ok',
      isSubagent: false
    }
    expect(visibleTranscriptParts([{ kind: 'text', text: 'Before' }, tool, { kind: 'text', text: 'After' }])).toEqual([
      { kind: 'text', text: 'Before' },
      tool,
      { kind: 'text', text: 'After' }
    ])
  })
})

describe('isBrowserTool', () => {
  it('recognizes direct and MCP-prefixed browser operations', () => {
    expect(isBrowserTool('navigate')).toBe(true)
    expect(isBrowserTool('reconix_eval_in_page')).toBe(true)
    expect(isBrowserTool('click')).toBe(true)
  })

  it('does not mark analysis-only tools as browser control', () => {
    expect(isBrowserTool('dom_evaluator')).toBe(false)
    expect(isBrowserTool('record_finding')).toBe(false)
    expect(isBrowserTool('task')).toBe(false)
  })
})

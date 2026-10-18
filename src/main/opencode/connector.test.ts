import { describe, expect, it } from 'vitest'
import type { AgentEvent, ServerStatus } from '../../shared/contracts'
import { OpenCodeConnector } from './connector'
import type { OpenCodeTransport, RawEvent } from './transport'

class EventTransport implements OpenCodeTransport {
  private release: (() => void) | undefined

  constructor(private readonly events: RawEvent[]) {}

  health(): Promise<boolean> {
    return Promise.resolve(true)
  }

  createSession(): Promise<{ id: string }> {
    return Promise.resolve({ id: 'parent-session' })
  }

  sendMessage(): Promise<{ messageId: string }> {
    return Promise.resolve({ messageId: 'message-1' })
  }

  respondPermission(): Promise<void> {
    return Promise.resolve()
  }

  abort(): Promise<void> {
    this.release?.()
    return Promise.resolve()
  }

  async *subscribe(signal: AbortSignal): AsyncIterable<RawEvent> {
    for (const event of this.events) yield event
    await new Promise<void>((resolve) => {
      this.release = resolve
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }
}

describe('OpenCodeConnector transcript isolation', () => {
  it('excludes non-durable background deltas so they cannot leave the chat busy', async () => {
    const visible: AgentEvent[] = []
    const persisted: RawEvent[] = []
    // Actual v2 SSE shapes: deltas have data.sessionID but no durable envelope.
    const transport = new EventTransport([
      { type: 'session.text.delta', data: { sessionID: 'ambient-parser', assistantMessageID: 'parser-message', delta: 'DOM summary' } },
      { type: 'session.reasoning.delta', data: { sessionID: 'ambient-parser', assistantMessageID: 'parser-message', delta: 'Analyzing' } },
      { type: 'session.execution.succeeded', data: { sessionID: 'ambient-parser' }, durable: { aggregateID: 'ambient-parser' } },
      { type: 'session.text.delta', data: { sessionID: 'parent-session', assistantMessageID: 'parent-message', delta: 'Ready' } },
      { type: 'session.execution.succeeded', data: { sessionID: 'parent-session' } }
    ])
    const connector = new OpenCodeConnector(transport, {
      onAgentEvent: (event) => visible.push(event),
      persist: (raw) => persisted.push(raw),
      onStatus: () => {}
    })
    await connector.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(persisted).toHaveLength(5)
    expect(visible).toEqual([
      { kind: 'message.delta', messageId: 'parent-message', role: 'assistant', text: 'Ready' },
      { kind: 'turn.done', messageId: 'parent-session' }
    ])
    await connector.stop()
  })

  it('persists child-session events but only publishes parent-session output', async () => {
    const visible: AgentEvent[] = []
    const persisted: RawEvent[] = []
    const statuses: ServerStatus[] = []
    const transport = new EventTransport([
      {
        type: 'session.text.delta',
        data: { assistantMessageID: 'child-message', delta: 'private specialist output' },
        durable: { aggregateID: 'child-session' }
      },
      {
        type: 'session.text.delta',
        data: { assistantMessageID: 'parent-message', delta: 'visible answer' },
        durable: { aggregateID: 'parent-session' }
      }
    ])
    const connector = new OpenCodeConnector(transport, {
      onAgentEvent: (event) => visible.push(event),
      persist: (raw) => persisted.push(raw),
      onStatus: (status) => statuses.push(status)
    })

    await connector.start()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(persisted).toHaveLength(2)
    expect(visible).toEqual([
      { kind: 'message.delta', messageId: 'parent-message', role: 'assistant', text: 'visible answer' }
    ])
    expect(statuses.at(-1)).toEqual({ state: 'ready' })

    await connector.stop()
  })
})

import { describe, expect, it, vi } from 'vitest'
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

class RecoveryTransport implements OpenCodeTransport {
  prompts: string[] = []
  aborts = 0
  acknowledge = true
  private queue: RawEvent[] = []
  private wake: (() => void) | undefined
  health = async (): Promise<boolean> => true
  createSession = async (): Promise<{ id: string }> => ({ id: 'parent-session' })
  sendMessage = async (_session: string, text: string): Promise<{ messageId: string }> => {
    this.prompts.push(text)
    return { messageId: 'inbox' }
  }
  respondPermission = async (): Promise<void> => {}
  abort = async (): Promise<void> => {
    this.aborts++
    if (this.acknowledge) this.emit('session.execution.interrupted')
  }
  emit(type: string, data: Record<string, unknown> = {}): void {
    this.queue.push({ type, data: { sessionID: 'parent-session', ...data } })
    this.wake?.()
  }
  async *subscribe(signal: AbortSignal): AsyncIterable<RawEvent> {
    while (!signal.aborted) {
      if (this.queue.length) yield this.queue.shift()!
      else await new Promise<void>((resolve) => {
        this.wake = resolve
        signal.addEventListener('abort', resolve as () => void, { once: true })
      })
    }
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const repeated = 'I will inspect the available evidence and examine the endpoint before selecting the next action to execute. '.repeat(4)

async function recoveryHarness(): Promise<{
  connector: OpenCodeConnector; transport: RecoveryTransport; visible: AgentEvent[]
}> {
  const transport = new RecoveryTransport()
  const visible: AgentEvent[] = []
  const connector = new OpenCodeConnector(transport, {
    onAgentEvent: (event) => visible.push(event), persist: () => {}, onStatus: () => {}
  })
  await connector.start()
  await connector.sendMessage('Inspect the target')
  return { connector, transport, visible }
}

describe('OpenCodeConnector progress recovery', () => {
  it('redirects a looping response after interruption without ending the visible turn', async () => {
    const { connector, transport, visible } = await recoveryHarness()
    transport.emit('session.text.delta', { assistantMessageID: 'm', delta: repeated })
    await settle()
    expect(transport.aborts).toBe(1)
    expect(transport.prompts).toHaveLength(2)
    expect(transport.prompts[1]).toContain('EXECUTE it now')
    expect(transport.prompts[1]).toContain('approval requirements')
    expect(visible.some((event) => event.kind === 'turn.done')).toBe(false)
    transport.emit('session.text.delta', { assistantMessageID: 'next', delta: 'Here is new evidence.' })
    transport.emit('session.execution.succeeded')
    await settle()
    expect(visible.at(-1)?.kind).toBe('turn.done')
    await connector.stop()
  })

  it('waits for acknowledgment and lets Suspend cancel recovery', async () => {
    const { connector, transport, visible } = await recoveryHarness()
    transport.acknowledge = false
    transport.emit('session.text.delta', { assistantMessageID: 'm', delta: repeated })
    await settle()
    expect(transport.prompts).toHaveLength(1)
    await connector.interrupt()
    transport.emit('session.execution.interrupted')
    await settle()
    expect(transport.prompts).toHaveLength(1)
    expect(visible.at(-1)?.kind).toBe('turn.done')
    await connector.stop()
  })

  it('redirects repeated failed tools and keeps the failure visible', async () => {
    const { connector, transport, visible } = await recoveryHarness()
    for (let i = 0; i < 3; i++) {
      transport.emit('session.tool.called', { id: `call${i}`, name: 'read', input: { path: 'missing' } })
      transport.emit('session.tool.failed', { id: `call${i}`, error: 'File does not exist' })
    }
    await settle()
    expect(transport.prompts).toHaveLength(2)
    expect(transport.prompts[1]).toContain('same tool, inputs and failure')
    expect(visible.filter((event) => event.kind === 'tool.result')).toHaveLength(3)
    await connector.stop()
  })

  it('recovers a completed repetitive response without interrupting an idle session', async () => {
    const { connector, transport } = await recoveryHarness()
    const block = 'abcdefghij'.repeat(8)
    transport.emit('session.text.delta', { assistantMessageID: 'm', delta: block.repeat(2) })
    transport.emit('session.text.delta', { assistantMessageID: 'm', delta: block })
    transport.emit('session.execution.succeeded')
    await settle()
    expect(transport.aborts).toBe(0)
    expect(transport.prompts).toHaveLength(2)
    await connector.stop()
  })

  it('bounds recovery and resets its budget on the next user message', async () => {
    const { connector, transport, visible } = await recoveryHarness()
    for (let i = 0; i < 3; i++) {
      transport.emit('session.text.delta', { assistantMessageID: `m${i}`, delta: repeated })
      await settle()
    }
    expect(transport.prompts).toHaveLength(3)
    expect(visible.at(-1)).toMatchObject({ kind: 'error', message: expect.stringContaining('two changes') })
    await connector.sendMessage('Try a new objective')
    transport.emit('session.text.delta', { assistantMessageID: 'fresh', delta: repeated })
    await settle()
    expect(transport.prompts).toHaveLength(5)
    await connector.stop()
  })

  it('does not send recovery if interruption fails', async () => {
    const { connector, transport, visible } = await recoveryHarness()
    transport.abort = async () => { throw new Error('interrupt failed: 503') }
    transport.emit('session.text.delta', { assistantMessageID: 'm', delta: repeated })
    await settle()
    expect(transport.prompts).toHaveLength(1)
    expect(visible.at(-1)).toMatchObject({ kind: 'error', message: expect.stringContaining('503') })
    await connector.stop()
  })

  it('fails clearly if the engine never acknowledges interruption', async () => {
    vi.useFakeTimers()
    const { connector, transport, visible } = await recoveryHarness()
    try {
      transport.acknowledge = false
      transport.emit('session.text.delta', { assistantMessageID: 'm', delta: repeated })
      await vi.advanceTimersByTimeAsync(5001)
      expect(transport.prompts).toHaveLength(1)
      expect(visible.at(-1)).toMatchObject({ kind: 'error', message: expect.stringContaining('acknowledge') })
    } finally {
      await connector.stop()
      vi.useRealTimers()
    }
  })

  it('does not recover healthy runs, child output, or a pending approval', async () => {
    const { connector, transport, visible } = await recoveryHarness()
    transport.emit('session.text.delta', { sessionID: 'child', assistantMessageID: 'child', delta: repeated })
    transport.emit('permission.asked', { id: 'approval', action: 'reconix_replay_request' })
    transport.emit('session.text.delta', { assistantMessageID: 'm', delta: repeated })
    await settle()
    expect(transport.prompts).toHaveLength(1)
    expect(transport.aborts).toBe(0)
    expect(visible.some((event) => event.kind === 'approval.request')).toBe(true)
    await connector.stop()
  })
})

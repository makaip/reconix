import { describe, expect, it, vi } from 'vitest'
import { COMMANDS, findCommand, interpret, matchCommands, type CommandContext } from './commands'

function makeContext(): CommandContext & {
  send: ReturnType<typeof vi.fn>
  newChat: ReturnType<typeof vi.fn>
  suspend: ReturnType<typeof vi.fn>
  openPanel: ReturnType<typeof vi.fn>
  setAllToolsEnabled: ReturnType<typeof vi.fn>
} {
  return {
    send: vi.fn(),
    newChat: vi.fn(),
    suspend: vi.fn(),
    openPanel: vi.fn(),
    setAllToolsEnabled: vi.fn()
  }
}

describe('interpret', () => {
  it('treats plain text as a message', () => {
    expect(interpret('what is in scope?')).toEqual({ kind: 'message', text: 'what is in scope?' })
  })

  it('escapes a leading // to a literal slash message', () => {
    expect(interpret('//navigate is a word')).toEqual({ kind: 'message', text: '/navigate is a word' })
  })

  it('resolves a known command with its args', () => {
    const result = interpret('/navigate https://example.com')
    expect(result.kind).toBe('command')
    if (result.kind !== 'command') throw new Error('expected command')
    expect(result.command.name).toBe('navigate')
    expect(result.args).toBe('https://example.com')
  })

  it('resolves a command with no args', () => {
    const result = interpret('/get_scope')
    expect(result.kind).toBe('command')
    if (result.kind !== 'command') throw new Error('expected command')
    expect(result.command.name).toBe('get_scope')
    expect(result.args).toBe('')
  })

  it('resolves an alias to its command', () => {
    const result = interpret('/clear')
    expect(result.kind).toBe('command')
    if (result.kind !== 'command') throw new Error('expected command')
    expect(result.command.name).toBe('new')
  })

  it('is case-insensitive on the command name', () => {
    const result = interpret('/NAVIGATE x')
    expect(result.kind).toBe('command')
  })

  it('routes /help to its own kind', () => {
    expect(interpret('/help')).toEqual({ kind: 'help' })
  })

  it('reports an unknown command', () => {
    expect(interpret('/nope')).toEqual({ kind: 'unknown', name: 'nope' })
  })
})

describe('command behaviour', () => {
  it('/new starts a new chat', () => {
    const ctx = makeContext()
    findCommand('new')!.run(ctx, '')
    expect(ctx.newChat).toHaveBeenCalledOnce()
  })

  it('/stop interrupts the turn', () => {
    const ctx = makeContext()
    findCommand('stop')!.run(ctx, '')
    expect(ctx.suspend).toHaveBeenCalledOnce()
  })

  it('/tools all enables every function', () => {
    const ctx = makeContext()
    findCommand('tools')!.run(ctx, 'all')
    expect(ctx.setAllToolsEnabled).toHaveBeenCalledWith(true)
    expect(ctx.openPanel).not.toHaveBeenCalled()
  })

  it('/tools none disables every function', () => {
    const ctx = makeContext()
    findCommand('tools')!.run(ctx, 'none')
    expect(ctx.setAllToolsEnabled).toHaveBeenCalledWith(false)
  })

  it('/tools with no arg opens the functions panel', () => {
    const ctx = makeContext()
    findCommand('tools')!.run(ctx, '')
    expect(ctx.openPanel).toHaveBeenCalledWith('tools')
  })

  it('a tool command sends an instruction with its args', () => {
    const ctx = makeContext()
    findCommand('navigate')!.run(ctx, 'https://example.com')
    expect(ctx.send).toHaveBeenCalledWith('Use the `navigate` tool with: https://example.com')
  })

  it('an agent command delegates via an @mention', () => {
    const ctx = makeContext()
    findCommand('dom-analyzer')!.run(ctx, 'inspect the login form')
    expect(ctx.send).toHaveBeenCalledWith('Delegate to @dom-analyzer: inspect the login form')
  })

  it('a skill command names the skill', () => {
    const ctx = makeContext()
    findCommand('z3-solver')!.run(ctx, '')
    expect(ctx.send).toHaveBeenCalledWith('Use the z3-solver skill.')
  })
})

describe('matchCommands', () => {
  it('returns the whole catalog for an empty fragment', () => {
    expect(matchCommands('')).toHaveLength(COMMANDS.length)
  })

  it('filters by name prefix', () => {
    const names = matchCommands('get_').map((command) => command.name)
    expect(names).toContain('get_scope')
    expect(names).toContain('get_cookies')
    expect(names).not.toContain('navigate')
  })

  it('matches aliases', () => {
    expect(matchCommands('clear').map((command) => command.name)).toContain('new')
  })
})

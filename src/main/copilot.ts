// Wires the renderer's Copilot panel to a real OpenCode instance (ARCHITECTURE
// §5.B / §6.3). Dev-mode only for now: spawns `opencode serve` as a child
// process and talks to it over loopback HTTP, same as the eventual Docker
// setup will once 5.D lands — the connector/transport layer doesn't care
// which one is on the other end.
//
// The orchestrator agent needs GOOGLE_GENERATIVE_AI_API_KEY in the
// environment (see index.ts's .env load) and opencode.json / the
// .opencode/agents/*.md files pinned to a real model — both are live as of
// 2026-10-17 (google/gemini-3.8-flash: confirmed working on this key's plan;
// the pro-tier preview models 404'd on a 0 free-tier quota, so flash is the
// default for both agents until that's upgraded).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import { app, ipcMain } from 'electron'
import type { AgentEvent, ApprovalDecision, ServerStatus } from '../shared/contracts'
import { createOpenCodeConnector, type OpenCodeConnector } from './opencode'
import type { RawEvent } from './opencode/transport'

const HOST = '127.0.0.1'
const PORT = 4097

export interface CopilotBridge {
  stop(): Promise<void>
}

export function createCopilotBridge(win: BrowserWindow): CopilotBridge {
  let child: ChildProcessWithoutNullStreams | null = null
  let connector: OpenCodeConnector | null = null
  let starting: Promise<OpenCodeConnector> | null = null

  const send = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }

  function spawnServer(): Promise<{ baseUrl: string; password: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('opencode', ['serve', '--hostname', HOST, '--port', String(PORT)], {
        // Not process.cwd() — that's wherever the OS launched Electron from,
        // not the project root. opencode.json / .opencode/agents/*.md live
        // relative to the project root, so the server has to start there to
        // see Reconix's own agents at all (confirmed: it silently resolved
        // to OpenCode's built-ins instead, no error, just the wrong agent).
        cwd: app.getAppPath(),
        stdio: 'pipe'
      })
      child = proc
      let url = ''
      let password = ''
      let buf = ''
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('utf8')
        const listeningMatch = buf.match(/server listening on (\S+)/)
        if (listeningMatch) url = listeningMatch[1]
        const passwordMatch = buf.match(/server password (\S+)/)
        if (passwordMatch) password = passwordMatch[1]
        if (url && password) {
          proc.stdout.off('data', onData)
          resolve({ baseUrl: url, password })
        }
      }
      proc.stdout.on('data', onData)
      proc.stderr.on('data', (chunk: Buffer) => console.error('[opencode serve]', chunk.toString('utf8')))
      proc.on('error', reject)
      proc.on('exit', (code) => {
        if (!url || !password) reject(new Error(`opencode serve exited (${code}) before it was ready`))
      })
      setTimeout(() => reject(new Error('opencode serve did not print a listening URL within 15s')), 15_000)
    })
  }

  async function ensureConnector(): Promise<OpenCodeConnector> {
    if (connector) return connector
    if (starting) return starting
    starting = (async () => {
      const { baseUrl, password } = await spawnServer()
      const c = createOpenCodeConnector(
        { baseUrl, password, agent: 'orchestrator' },
        {
          onAgentEvent: (ev: AgentEvent) => send('copilot:event', ev),
          persist: (_raw: RawEvent, _normalized: AgentEvent | null) => {
            // TODO(B): write through to the engagement store (§6.4) once it
            // exists. Dropped on the floor for now — not a regression, there
            // was no store before this either.
          },
          onStatus: (status: ServerStatus) => send('copilot:status', status)
        }
      )
      await c.start()
      connector = c
      return c
    })()
    try {
      return await starting
    } finally {
      starting = null
    }
  }

  ipcMain.handle('copilot:send', async (_event, text: string) => {
    const c = await ensureConnector()
    return c.sendMessage(String(text))
  })

  ipcMain.handle('copilot:respond-approval', async (_event, approvalId: string, decision: ApprovalDecision) => {
    const c = await ensureConnector()
    return c.respondApproval(String(approvalId), decision)
  })

  return {
    async stop() {
      ipcMain.removeHandler('copilot:send')
      ipcMain.removeHandler('copilot:respond-approval')
      await connector?.stop().catch(() => undefined)
      child?.kill()
    }
  }
}

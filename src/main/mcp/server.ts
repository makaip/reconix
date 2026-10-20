// Real MCP transport (ARCHITECTURE §6.2 seam, finally plugged in). Wraps our
// transport-agnostic ToolRegistry/McpServer (index.ts) in the official
// @modelcontextprotocol/sdk, exposed over Streamable HTTP on loopback so an
// external `opencode serve` process (which OpenCode's own `mcp.servers.*.type:
// "remote"` config connects to) can reach it. This has to live in a separate
// HTTP server — not spawned by OpenCode as a stdio command — because the tool
// handlers need the live Electron WebContentsView for CDP driving, which only
// exists inside this process.
//
// Confirmed live against `opencode mcp add --url ...` (writes
// mcp.servers.<name> = {type:"remote", url}) and `opencode serve`'s actual
// MCP client, not assumed from the spec alone.

import { createServer, type Server as HttpServer } from 'node:http'
import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer as ReconixMcpServer } from './index'
import { clampToolResult } from './limits'

export interface McpHttpServer {
  readonly port: number
  readonly url: string
  stop(): Promise<void>
}

function buildSdkServer(reconix: ReconixMcpServer): McpSdkServer {
  const sdk = new McpSdkServer({ name: 'reconix', version: '0.1.0' }, { capabilities: { tools: {} } })

  sdk.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: reconix.listTools().map((t) => ({
      name: t.name,
      description: t.description,
      // JsonSchema is already the wire shape tools/list wants; no Zod conversion needed.
      inputSchema: t.inputSchema as { type: 'object'; [k: string]: unknown }
    }))
  }))

  sdk.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await reconix.callTool(req.params.name, req.params.arguments ?? {})
    if (result.ok) {
      // Clamp here so the ceiling covers EVERY tool uniformly — including Dev
      // 1's custom tools and anything added later — not just the ones that
      // remembered to cap themselves. An oversized result overflows the
      // orchestrator's context and surfaces as session.execution.failed, so
      // this is the last line of defense against a turn-killing tool output.
      const text = clampToolResult(JSON.stringify(result.output ?? null))
      return { content: [{ type: 'text' as const, text }] }
    }
    return {
      content: [{ type: 'text' as const, text: clampToolResult(JSON.stringify(result.error)) }],
      isError: true
    }
  })

  sdk.onerror = (err) => console.error('[reconix-mcp] server error:', err)
  return sdk
}

export async function startMcpHttpServer(
  reconix: ReconixMcpServer,
  opts: { port: number; path?: string }
): Promise<McpHttpServer> {
  const path = opts.path ?? '/mcp'

  // Stateless mode (sessionIdGenerator: undefined) is single-shot by design —
  // confirmed live (a 500 on the second request) and in the SDK source
  // (webStandardStreamableHttp.js: "Stateless transport cannot be reused
  // across requests. Create a new transport per request."). A shared
  // long-lived transport instance — the obvious thing to reach for, and
  // what the class name/constructor-once pattern suggests — throws on every
  // request after the first. So: fresh Server + fresh transport per request.
  const http: HttpServer = createServer((req, res) => {
    if (req.url !== path) {
      res.writeHead(404).end()
      return
    }
    // CORS preflight / browser probes / health checks hit this endpoint without
    // the SSE accept header and would otherwise trip the SDK's transport error
    // handler (noisy, harmless 406). Answer them directly and quietly.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id'
      }).end()
      return
    }
    const accept = String(req.headers['accept'] ?? '')
    if (req.method === 'GET' && !accept.includes('text/event-stream')) {
      res.writeHead(406, { 'Content-Type': 'text/plain' }).end('MCP endpoint requires Accept: text/event-stream')
      return
    }
    void (async () => {
      const sdk = buildSdkServer(reconix)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      transport.onerror = (err) => console.error('[reconix-mcp] transport error:', err)
      try {
        await sdk.connect(transport)
        await transport.handleRequest(req, res)
      } catch (err) {
        console.error('[reconix-mcp] handleRequest threw:', err)
        if (!res.headersSent) res.writeHead(500).end()
      } finally {
        await transport.close().catch(() => undefined)
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(opts.port, '127.0.0.1', () => resolve())
  })

  return {
    port: opts.port,
    url: `http://127.0.0.1:${opts.port}${path}`,
    async stop() {
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  }
}

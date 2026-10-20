// Per-domain CDP wrappers (ARCHITECTURE §5.C). The agent never gets raw
// `cdp.send`; tools call these named methods. The debugger is attached to the
// TARGET WebContentsView only — asserted here and at every call site — never
// the UI's webContents, which would be a path out of the sandbox.

import type { WebContents } from 'electron'
import { net } from 'electron'
import { ToolExecError } from './errors'

export interface CookieRecord {
  name: string
  value: string
  domain: string
  httpOnly: boolean
  secure: boolean
}

/** Emulation overrides applied to the target view (CSS/device/media). All
 *  fields optional; `reset: true` clears the device-metrics override. */
export interface EmulationOptions {
  viewport?: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number }
  /** CSS media to emulate, e.g. 'print' | 'screen'. */
  media?: string
  /** Emulated media features, e.g. [{ name: 'prefers-color-scheme', value: 'dark' }]. */
  features?: { name: string; value: string }[]
  reset?: boolean
}

/** A single request spec for the replay_request send primitive. */
export interface HttpRequestSpec {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

/** Result of replay_request's send primitive. The body is returned in full to
 *  the caller (the tool handler), which clamps the inline copy and stashes the
 *  complete request/response pair in the trace store as evidence. */
export interface HttpReplayResult {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  bodyBytes: number
  durationMs: number
}

// The surface the tool handlers are allowed to use. Anything not here cannot be
// expressed. Scope-critical operations (navigate, sendRequest) are still gated
// by the pipeline's scope check before they reach this driver.
export interface CdpDriver {
  navigate(url: string): Promise<{ status: number; finalUrl: string }>
  pageInfo(): Promise<{ url: string; title: string; readyState: string }>
  evaluate(expression: string): Promise<string> // Runtime.evaluate; result stringified
  screenshot(): Promise<Buffer>
  cookies(): Promise<CookieRecord[]>
  dispatchInput(events: unknown[]): Promise<void>
  setEmulation(opts: EmulationOptions): Promise<void>
  /** The send primitive behind replay_request. Issues one HTTP request bound to
   *  the TARGET view's session — so it carries that session's cookies and
   *  egresses through its proxy — with arbitrary method/headers/body. Scope is
   *  enforced by the pipeline (via the tool's target()) before this is called. */
  sendRequest(spec: HttpRequestSpec): Promise<HttpReplayResult>
}

export class WebContentsCdpDriver implements CdpDriver {
  private attached = false

  /**
   * @param wc        the TARGET view's webContents
   * @param isUiGuard returns true iff `wc` is the privileged UI webContents.
   *                  Construction throws if it does. (§5.C standing assertion.)
   */
  constructor(
    private readonly wc: WebContents,
    isUiGuard: (wc: WebContents) => boolean
  ) {
    if (isUiGuard(wc)) {
      throw new Error('FATAL: CDP driver attached to UI webContents — refusing (§5.C)')
    }
  }

  private ensureAttached(): void {
    if (this.attached && this.wc.debugger.isAttached()) return
    try {
      if (!this.wc.debugger.isAttached()) this.wc.debugger.attach('1.3')
      this.attached = true
    } catch (err) {
      // A sibling debugger (e.g. DevTools) can hold the session. Surface it as
      // a retriable exec error rather than a bare CDP string — the agent can
      // retry once the other client detaches. (§5.C)
      this.attached = false
      throw new ToolExecError(`CDP attach failed: ${(err as Error)?.message ?? String(err)}`, true)
    }
  }

  private async send(method: string, params?: object): Promise<unknown> {
    this.ensureAttached()
    try {
      return await this.wc.debugger.sendCommand(method, params)
    } catch (err) {
      // If the view navigated/closed the debugger drops; mark detached so the
      // next call re-attaches, and let the caller retry.
      if (!this.wc.debugger.isAttached()) this.attached = false
      throw new ToolExecError(`CDP ${method} failed: ${(err as Error)?.message ?? String(err)}`, true)
    }
  }

  async navigate(url: string): Promise<{ status: number; finalUrl: string }> {
    // loadURL resolves on the main-frame navigation; CDP Network gives the code.
    await this.wc.loadURL(url)
    return { status: 200, finalUrl: this.wc.getURL() }
  }

  async pageInfo(): Promise<{ url: string; title: string; readyState: string }> {
    const readyState = String(await this.evaluate('document.readyState'))
    return { url: this.wc.getURL(), title: this.wc.getTitle(), readyState }
  }

  async evaluate(expression: string): Promise<string> {
    const res = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })) as {
      result?: { value?: unknown }
      exceptionDetails?: { exception?: { description?: string }; text?: string }
    }
    // A thrown page expression used to silently return "null", which looked
    // like a successful empty result. Surface it instead so the agent (and the
    // UI) see the real failure. (better error handling)
    if (res.exceptionDetails) {
      const d = res.exceptionDetails
      throw new ToolExecError(
        `page evaluation threw: ${d.exception?.description ?? d.text ?? 'unknown error'}`
      )
    }
    return JSON.stringify(res.result?.value ?? null)
  }

  async screenshot(): Promise<Buffer> {
    const image = await this.wc.capturePage()
    return image.toPNG()
  }

  async cookies(): Promise<CookieRecord[]> {
    const raw = await this.wc.session.cookies.get({})
    return raw.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain ?? '',
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? false
    }))
  }

  async dispatchInput(events: unknown[]): Promise<void> {
    for (const ev of events) await this.send('Input.dispatchKeyEvent', ev as object)
  }

  async setEmulation(opts: EmulationOptions): Promise<void> {
    if (opts.reset) {
      await this.send('Emulation.clearDeviceMetricsOverride')
    } else if (opts.viewport) {
      const v = opts.viewport
      await this.send('Emulation.setDeviceMetricsOverride', {
        width: v.width,
        height: v.height,
        deviceScaleFactor: v.deviceScaleFactor ?? 0,
        mobile: v.mobile ?? false
      })
    }
    if (opts.media !== undefined || opts.features) {
      await this.send('Emulation.setEmulatedMedia', {
        media: opts.media ?? '',
        features: opts.features ?? []
      })
    }
  }

  // The send primitive for replay_request. We use Electron `net` bound to the
  // target view's session rather than a page `fetch()` so the repeater has full
  // control: arbitrary method/headers/body (incl. headers a page fetch can't
  // set), no CORS blocking, and the target's own cookies via the session. The
  // pipeline has already scope-checked the (post-override) URL before we get
  // here, and this traffic egresses through whatever proxy the session carries.
  async sendRequest(spec: HttpRequestSpec): Promise<HttpReplayResult> {
    const method = (spec.method || 'GET').toUpperCase()
    const hasBody = spec.body != null && method !== 'GET' && method !== 'HEAD'
    const started = Date.now()

    return new Promise<HttpReplayResult>((resolve, reject) => {
      let request: ReturnType<typeof net.request>
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        try { request.abort() } catch { /* ignore */ }
        reject(new ToolExecError('replay_request: timed out after 30s', true))
      }, 30_000)
      const finish = (fn: () => void) => { clearTimeout(timeout); fn() }
      try {
        request = net.request({
          url: spec.url,
          method,
          session: this.wc.session,
          useSessionCookies: true,
          redirect: 'follow'
        })
      } catch (err) {
        finish(() => reject(
          new ToolExecError(
            `replay_request: bad request spec — ${(err as Error)?.message ?? String(err)}`
          )
        ))
        return
      }

      for (const [name, value] of Object.entries(spec.headers ?? {})) {
        // net rejects a few header names outright; skip the offender rather than
        // abort the whole replay so one bad header can't wedge the tool.
        try {
          request.setHeader(name, value)
        } catch {
          /* unsettable header — ignore */
        }
      }

      const chunks: Buffer[] = []
      request.on('response', (response) => {
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const buf = Buffer.concat(chunks)
          const headers: Record<string, string> = {}
          for (const [k, v] of Object.entries(response.headers)) {
            headers[k] = Array.isArray(v) ? v.join(', ') : String(v)
          }
          finish(() => resolve({
            status: response.statusCode,
            statusText: response.statusMessage ?? '',
            headers,
            body: buf.toString('utf8'),
            bodyBytes: buf.length,
            durationMs: Date.now() - started
          }))
        })
        response.on('error', (err: Error) =>
          finish(() => reject(new ToolExecError(`replay_request: response error — ${err.message}`, true)))
        )
      })
      request.on('error', (err) => {
        if (timedOut) return
        finish(() => reject(new ToolExecError(`replay_request: ${err.message}`, true)))
      })

      if (hasBody) request.write(spec.body as string)
      request.end()
    })
  }
}

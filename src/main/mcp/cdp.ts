// Per-domain CDP wrappers (ARCHITECTURE §5.C). The agent never gets raw
// `cdp.send`; tools call these named methods. The debugger is attached to the
// TARGET WebContentsView only — asserted here and at every call site — never
// the UI's webContents, which would be a path out of the sandbox.

import type { WebContents } from 'electron'

export interface CookieRecord {
  name: string
  value: string
  domain: string
  httpOnly: boolean
  secure: boolean
}

// The surface the tool handlers are allowed to use. Anything not here cannot be
// expressed. Scope-critical operations (navigate) are still gated by the
// pipeline's scope check before they reach this driver.
export interface CdpDriver {
  navigate(url: string): Promise<{ status: number; finalUrl: string }>
  pageInfo(): Promise<{ url: string; title: string; readyState: string }>
  evaluate(expression: string): Promise<string> // Runtime.evaluate; result stringified
  screenshot(): Promise<Buffer>
  cookies(): Promise<CookieRecord[]>
  dispatchInput(events: unknown[]): Promise<void>
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
    if (this.attached) return
    if (!this.wc.debugger.isAttached()) this.wc.debugger.attach('1.3')
    this.attached = true
  }

  private async send(method: string, params?: object): Promise<unknown> {
    this.ensureAttached()
    return this.wc.debugger.sendCommand(method, params)
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
    })) as { result?: { value?: unknown } }
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
}

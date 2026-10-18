/**
 * Reconix dynamic deobfuscation harness (P3).
 *
 * PURPOSE
 *   Static analysis cannot see values that only exist at runtime: string arrays
 *   rotated by a function call, decoders that read `window`/`document`, and code
 *   strings handed to `eval` / `Function` / `document.write` / string timers.
 *   This snippet is injected into the TARGET PAGE (never the UI). It wraps the
 *   runtime resolvers and records what they were given and what they produced,
 *   so the agent can analyze the trace with `deobfuscate_dynamic`.
 *
 * CONTROL MODEL (inject the same snippet repeatedly)
 *   - 1st injection  -> installs the hooks, returns {"status":"installed",...}.
 *   - later injection -> returns {"status":"dumped","entries":[...],...}.
 *   Set `window.__reconix_deobf_cmd__` before injecting to run a command:
 *     "clear"     -> empties the trace, returns {"status":"cleared"}.
 *     "uninstall" -> restores every patched global, returns {"status":"uninstalled"}.
 *   (The command global is consumed and removed on each accepted command.)
 *
 * SAFETY / LIMITS
 *   - Runs ONLY inside the isolated target WebContentsView (own partition, no
 *     Node). It is not a tool, opens no sockets, and never sends anything.
 *   - It replaces `eval`/`Function` on the page, which can change page behaviour
 *     (direct eval becomes indirect). Acceptable on an authorized engagement
 *     target; do not run it against pages you are not authorized to modify.
 *   - Every wrap is fail-safe: if a global cannot be patched, install continues.
 *   - The trace is capped (entry count + per-string length) and dropped records
 *     are counted, so it cannot flood the agent's context. Text only; captured
 *     code is never executed.
 */
;(() => {
  const TRACE_KEY = "__reconix_deobf_trace__"
  const INSTALLED_KEY = "__reconix_deobf_installed"
  const ORIGINALS_KEY = "__reconix_deobf_originals"
  const META_KEY = "__reconix_deobf_meta__"
  const CMD_KEY = "__reconix_deobf_cmd__"
  const SCHEMA_VERSION = 1
  const MAX_STACK = 400
  const MAX_URL = 400

  // Optional tuning, read from `window.__reconix_deobf_config__` before install:
  //   { maxEntries?: number, maxString?: number, fromCharCodeMin?: number }
  const config =
    window.__reconix_deobf_config__ && typeof window.__reconix_deobf_config__ === "object"
      ? window.__reconix_deobf_config__
      : {}
  const MAX_ENTRIES = typeof config.maxEntries === "number" ? config.maxEntries : 400
  const MAX_STRING = typeof config.maxString === "number" ? config.maxString : 4000
  const FROM_CHAR_CODE_MIN =
    typeof config.fromCharCodeMin === "number" ? config.fromCharCodeMin : 8 // long char-code arrays are the obfuscation signature

  // --- control commands over an already-installed harness -------------------
  const command = window[CMD_KEY]
  if (window[INSTALLED_KEY]) {
    if (command === "clear") {
      const trace = window[TRACE_KEY] || []
      trace.length = 0
      const meta = window[META_KEY]
      if (meta) {
        meta.dropped = 0
        meta.lastClearedAt = Date.now()
      }
      delete window[CMD_KEY]
      return JSON.stringify({ status: "cleared" })
    }
    if (command === "uninstall") {
      const originals = window[ORIGINALS_KEY] || []
      for (const entry of originals) {
        try {
          entry.target[entry.prop] = entry.value
        } catch {
          // the page may have redefined or frozen it; nothing more we can do
        }
      }
      delete window[INSTALLED_KEY]
      delete window[ORIGINALS_KEY]
      delete window[CMD_KEY]
      return JSON.stringify({ status: "uninstalled" })
    }
    return JSON.stringify(dumpPayload())
  }

  // --- install --------------------------------------------------------------
  const trace = []
  const originals = []
  const meta = {
    schemaVersion: SCHEMA_VERSION,
    installedAt: Date.now(),
    phase: detectPhase(),
    pageUrl: currentUrl(),
    dropped: 0
  }
  window[TRACE_KEY] = trace
  window[ORIGINALS_KEY] = originals
  window[META_KEY] = meta

  // Set whenever `clip` drops characters, so a record carries an explicit
  // truncation marker instead of consumers inferring it from a trailing "…".
  let clipped = false

  function clip(value) {
    try {
      if (typeof value === "string") {
        if (value.length > MAX_STRING) {
          clipped = true
          return value.slice(0, MAX_STRING) + "…"
        }
        return value
      }
      if (typeof value === "function") return "[function]"
      if (typeof value === "undefined") return "[undefined]"
      const json = JSON.stringify(value)
      if (json === undefined) return String(value)
      if (json.length > MAX_STRING) {
        clipped = true
        return json.slice(0, MAX_STRING) + "…"
      }
      return json
    } catch {
      return "[unserializable]"
    }
  }

  function detectPhase() {
    try {
      const readyState = document && document.readyState
      if (readyState === "loading") return "pre-document"
      if (readyState) return "post-load"
    } catch {
      // ignore
    }
    return "unknown"
  }

  function currentUrl() {
    try {
      return typeof location !== "undefined" && location.href
        ? String(location.href).slice(0, MAX_URL)
        : ""
    } catch {
      return ""
    }
  }

  function stackHint() {
    try {
      const raw = new Error().stack || ""
      const frames = raw.split("\n").slice(2, 4).join(" | ").trim()
      return frames.length > MAX_STACK ? frames.slice(0, MAX_STACK) : frames
    } catch {
      return ""
    }
  }

  function record(kind, detail) {
    const truncated = clipped
    clipped = false
    if (trace.length >= MAX_ENTRIES) {
      meta.dropped += 1
      return
    }
    const entry = Object.assign(
      { t: Date.now(), kind, phase: meta.phase, sourceUrl: meta.pageUrl },
      detail
    )
    if (truncated) entry.truncated = true
    const stack = stackHint()
    if (stack) entry.stack = stack
    trace.push(entry)
  }

  /** Patch a global fail-safely, remembering the original for `uninstall`. */
  function safeWrap(target, prop, make) {
    try {
      const original = target[prop]
      if (typeof original !== "function") return
      const wrapped = make(original)
      target[prop] = wrapped
      originals.push({ target, prop, value: original })
    } catch {
      // leave this global untouched; the rest of the install continues
    }
  }

  function dumpPayload() {
    const installed = window[META_KEY] || {}
    return {
      status: "dumped",
      schemaVersion: SCHEMA_VERSION,
      phase: installed.phase,
      pageUrl: installed.pageUrl,
      installedAt: installed.installedAt,
      dumpedAt: Date.now(),
      dropped: installed.dropped || 0,
      entries: window[TRACE_KEY] || []
    }
  }

  // --- eval / Function ------------------------------------------------------
  safeWrap(window, "eval", (original) => function (code) {
    const result = original.call(this, code)
    record("eval", {
      code: clip(typeof code === "string" ? code : String(code)),
      result: clip(result)
    })
    return result
  })

  safeWrap(window, "Function", (OriginalFunction) => {
    const wrapped = function (...args) {
      const body = args.length ? String(args[args.length - 1]) : ""
      record("function", { code: clip(body) })
      return new OriginalFunction(...args)
    }
    try {
      wrapped.prototype = OriginalFunction.prototype
    } catch {
      // ignore
    }
    return wrapped
  })

  // --- document.write / writeln --------------------------------------------
  if (typeof document !== "undefined" && document) {
    safeWrap(document, "write", (original) => function (...args) {
      record("document.write", { code: clip(args.join("")) })
      return original.apply(document, args)
    })
    safeWrap(document, "writeln", (original) => function (...args) {
      record("document.writeln", { code: clip(args.join("")) })
      return original.apply(document, args)
    })
  }

  // --- string timers (deferred code) ---------------------------------------
  safeWrap(window, "setTimeout", (original) => function (handler, delay, ...rest) {
    if (typeof handler === "string") record("setTimeout", { code: clip(handler), delay })
    return original.apply(window, [handler, delay, ...rest])
  })
  safeWrap(window, "setInterval", (original) => function (handler, delay, ...rest) {
    if (typeof handler === "string") record("setInterval", { code: clip(handler), delay })
    return original.apply(window, [handler, delay, ...rest])
  })

  // --- string codecs --------------------------------------------------------
  for (const name of [
    "atob",
    "btoa",
    "unescape",
    "escape",
    "decodeURIComponent",
    "encodeURIComponent",
    "decodeURI",
    "encodeURI"
  ]) {
    safeWrap(window, name, (original) => function (input) {
      const result = original.call(window, input)
      record(name, { input: clip(input), result: clip(result) })
      return result
    })
  }

  // --- String.fromCharCode / fromCodePoint ---------------------------------
  safeWrap(String, "fromCharCode", (original) => function (...codes) {
    const result = original.apply(String, codes)
    if (codes.length >= FROM_CHAR_CODE_MIN) {
      record("String.fromCharCode", { codes: codes.slice(0, 256), result: clip(result) })
    }
    return result
  })
  safeWrap(String, "fromCodePoint", (original) => function (...codes) {
    const result = original.apply(String, codes)
    if (codes.length >= FROM_CHAR_CODE_MIN) {
      record("String.fromCodePoint", { codes: codes.slice(0, 256), result: clip(result) })
    }
    return result
  })

  window[INSTALLED_KEY] = true
  return JSON.stringify({ status: "installed", phase: meta.phase, entries: 0 })
})()

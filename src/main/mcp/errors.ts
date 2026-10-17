// Typed errors raised across the tool pipeline. The pipeline converts these
// into tool.result { ok:false } + an audit outcome row (API.md §4).

export class ToolInputError extends Error {
  readonly code = 'TOOL_INPUT'
  readonly retriable = false
  constructor(message: string) {
    super(message)
    this.name = 'ToolInputError'
  }
}

export class ScopeError extends Error {
  readonly code = 'OUT_OF_SCOPE'
  readonly retriable = false
  constructor(public readonly target: string) {
    super(`Target out of scope: ${target}`)
    this.name = 'ScopeError'
  }
}

export class ToolExecError extends Error {
  readonly code = 'TOOL_EXEC'
  constructor(
    message: string,
    public readonly retriable = false
  ) {
    super(message)
    this.name = 'ToolExecError'
  }
}

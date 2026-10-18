// Per-model price table for the cost/latency dashboard.
//
// Prices are USD per 1,000,000 tokens and are only used when OpenCode does not
// already report a cost on the event (prefer the reported figure). The local
// vLLM orchestrator is self-hosted, so its marginal cost is $0 regardless of
// token count — model that explicitly rather than pricing it.

export interface ModelPrice {
  /** USD per 1M input (prompt) tokens. */
  input: number
  /** USD per 1M output (completion) tokens. */
  output: number
}

/** Providers we run ourselves; their tokens are free at the margin. */
export const SELF_HOSTED_PREFIXES: readonly string[] = ['vllm-orchestrator/']

/**
 * Known prices, keyed by "provider/model". Unknown models return undefined so
 * the UI can render "—" instead of a misleading $0.00. Keep in sync with the
 * model constants in copilot.ts / opencode.json.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPrice>> = {
  'gemini/gemini-flash-lite-latest': { input: 0.075, output: 0.3 },
  // OpenCode Zen serves grok-code-fast-1 free; $0 at the margin.
  'opencode/grok-code': { input: 0, output: 0 }
}

export function isSelfHosted(model: string): boolean {
  return SELF_HOSTED_PREFIXES.some((prefix) => model.startsWith(prefix))
}

export function priceFor(model: string): ModelPrice | undefined {
  if (isSelfHosted(model)) return { input: 0, output: 0 }
  return MODEL_PRICING[model]
}

/**
 * Estimated USD for a turn, or undefined when the model is unknown/no price is
 * available. Self-hosted models price to 0.
 */
export function estimateCostUsd(
  model: string,
  inputTokens = 0,
  outputTokens = 0
): number | undefined {
  const price = priceFor(model)
  if (!price) return undefined
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output
}

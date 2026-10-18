// Merges Reconix's `opencode.json` into the user's existing GLOBAL OpenCode
// config instead of overwriting it wholesale.
//
// The repo's `opencode.json` is the source of truth for the keys Reconix
// manages — `providers`, `agents`, `mcp`, `model`, `default_agent`,
// `permissions`. But a user's global `~/.config/opencode/opencode.json` also
// carries keys Reconix knows nothing about, most importantly `plugins`.
// Blindly replacing that file silently disabled the user's personal plugins:
// losing `oh-my-opencode-slim`, for example, made its `orchestrator` agent
// vanish from the UI entirely, with no error and nothing pointing at Reconix
// as the cause.
//
// `mergeConfig` keeps Reconix's keys authoritative (repo wins), preserves
// anything only the user had, and deep-merges nested objects so a user's
// extra provider/mcp entry survives alongside Reconix's. Arrays are replaced,
// not concatenated (the repo defines ordering for the arrays it sets).

export type JsonObject = Record<string, unknown>

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep-merges `repo` on top of `existing`. `repo` wins at every leaf, objects
 * are merged recursively, and keys present only in `existing` are preserved.
 */
export function mergeConfig(repo: JsonObject, existing?: JsonObject): JsonObject {
  const merged: JsonObject = existing ? { ...existing } : {}
  for (const [key, repoValue] of Object.entries(repo)) {
    const existingValue = merged[key]
    merged[key] =
      isPlainObject(repoValue) && isPlainObject(existingValue)
        ? mergeConfig(repoValue, existingValue)
        : repoValue
  }
  return merged
}

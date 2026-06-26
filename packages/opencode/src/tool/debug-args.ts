import * as Log from "@opencode-ai/core/util/log"

// Diagnostics-only logger. Emits entries ONLY when
// `OPENCODE_DEBUG_TOOL_ARGS` is set to `1`/`true`/`yes` (case-insensitive).
// The intent is to narrow down where `process` (or any other tool) is being
// called with `{}` — the AI SDK adapter, the session processor, the AI SDK
// `execute` bridge, or the tool wrapper's schema decode. This is a
// no-op in normal runs: the gate short-circuits before any allocation.
//
// Keeping this in a dedicated file (rather than re-declaring per-site) avoids
// drift between logging sites and keeps the env name in one place. The
// helper is intentionally minimal so it does not pull in extra dependencies.

const MAX_PREVIEW_CHARS = 8_000

const log = Log.create({ service: "tool.debug-args" })

function envTruthy(value: string | undefined): boolean {
  if (value === undefined) return false
  const lower = value.toLowerCase()
  return lower === "1" || lower === "true" || lower === "yes"
}

export function debugToolArgsEnabled(): boolean {
  // `process.env` is the only authoritative signal here. The probe is
  // intentionally cheap and side-effect-free so it is safe to call on every
  // tool invocation.
  return envTruthy(process.env.OPENCODE_DEBUG_TOOL_ARGS)
}

// Summarize a tool-call input value so the diagnostic log shows enough shape
// to tell apart `{}`, `undefined`, `null`, a string, an array, or an object
// with keys — without dumping unbounded payload. Returned shape is JSON-safe
// and stable across log sites.
export function inputSummary(value: unknown): {
  readonly kind: "undefined" | "null" | "string" | "number" | "boolean" | "array" | "object" | "function" | "symbol" | "bigint" | "unknown"
  readonly keys: ReadonlyArray<string> | undefined
  readonly preview: string
} {
  if (value === undefined) return { kind: "undefined", keys: undefined, preview: "undefined" }
  if (value === null) return { kind: "null", keys: undefined, preview: "null" }
  if (Array.isArray(value)) return { kind: "array", keys: undefined, preview: safePreview(value) }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>)
    return { kind: "object", keys, preview: safePreview(value) }
  }
  return { kind: typeof value as never, keys: undefined, preview: safePreview(value) }
}

function safePreview(value: unknown): string {
  let raw: string
  try {
    raw = JSON.stringify(value)
  } catch {
    raw = String(value)
  }
  if (raw.length <= MAX_PREVIEW_CHARS) return raw
  return raw.slice(0, MAX_PREVIEW_CHARS) + "...<truncated>"
}

// Single entry point used by every log site. Keeps the log line shape
// uniform so the caller can grep for `stage=` across files.
export function logToolArgs(stage: string, fields: Record<string, unknown>): void {
  if (!debugToolArgsEnabled()) return
  log.debug("tool args diagnostic", { stage, ...fields })
}

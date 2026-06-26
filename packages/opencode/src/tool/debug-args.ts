import * as Log from "@opencode-ai/core/util/log"

// Diagnostics-only logger. Emits entries ONLY when
// `OPENCODE_DEBUG_TOOL_ARGS` is set to `1`/`true`/`yes` (case-insensitive).
// The intent is to narrow down where `process` (or any other tool) is being
// called with `{}` — the AI SDK adapter, the session processor, the AI SDK
// `execute` bridge, or the tool wrapper's schema decode.
//
// Hot-path discipline: when the env is OFF, the field builder is not invoked,
// so no `inputSummary()`, no `JSON.stringify()`, no preview generation, and no
// diagnostic log emission occurs. Call sites may still allocate the closure
// passed to `logToolArgsLazy`; the guarantee is that the expensive diagnostic
// work is skipped, not that the surrounding call site is allocation-free.

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
// and stable across log sites. Pure and allocation-light; safe to call from
// inside the field builder passed to `logToolArgsLazy`.
export function inputSummary(value: unknown): {
  readonly kind:
    | "undefined"
    | "null"
    | "string"
    | "number"
    | "boolean"
    | "array"
    | "object"
    | "function"
    | "symbol"
    | "bigint"
    | "unknown"
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

// Robust preview generator. `JSON.stringify` returns `undefined` (not throw)
// for values it cannot represent — functions, symbols, `undefined`, and
// BigInt — and a plain `length` access would crash. We coerce to a string
// and only then bound by length.
function safePreview(value: unknown): string {
  let raw: string
  try {
    const json = JSON.stringify(value)
    raw = json === undefined ? String(value) : json
  } catch {
    // Circular structures and other JSON.stringify failures fall back to
    // String(value) — best-effort, never throws out of this function.
    raw = String(value)
  }
  if (raw.length <= MAX_PREVIEW_CHARS) return raw
  return raw.slice(0, MAX_PREVIEW_CHARS) + "...<truncated>"
}

// Lazy variant. The field builder runs ONLY after the env gate has accepted
// the call, so env-off traffic skips the expensive diagnostic work: the
// builder is not invoked, so there is no `inputSummary()`, no
// `JSON.stringify()`, no preview generation, and no log emission. This is
// the variant every hot-path tool call site should use. Note: the closure
// passed to this function is still allocated at the call site; the
// guarantee is about the work inside the closure, not its allocation.
export function logToolArgsLazy(stage: string, fields: () => Record<string, unknown>): void {
  if (!debugToolArgsEnabled()) return
  // Wrap in try/catch so a buggy field builder cannot break the tool call.
  // The env gate is intentionally inside the gate, not inside the catch:
  // we still want any error to surface in normal runs if a caller forgets
  // the env gate, but we never want the helper itself to throw across the
  // tool boundary.
  let payload: Record<string, unknown>
  try {
    payload = fields()
  } catch (error) {
    payload = { builderError: error instanceof Error ? error.message : String(error) }
  }
  log.debug("tool args diagnostic", { stage, ...payload })
}

import { createHash } from "node:crypto"
import type { ModelMessage, Tool } from "ai"
import type { LLMEvent } from "@opencode-ai/llm"
import * as Stream from "effect/Stream"
import { Schema, Types } from "effect"

export const CACHE_RELEVANT_HEADER_KEYS: ReadonlyArray<string> = [
  "x-opencode-project",
  "x-opencode-session",
  "x-opencode-request",
  "x-opencode-client",
  "x-session-affinity",
  "x-parent-session-id",
] as const

// Headers explicitly excluded from the canonical fingerprint. These either
// rotate per-request, are server-side identity material, or do not affect
// the provider's prompt cache hit/miss decision.
const FINGERPRINT_HEADER_EXCLUDE: ReadonlySet<string> = new Set([
  "authorization",
  "user-agent",
  "x-opencode-request",
  "x-opencode-session",
  "x-opencode-client",
  "x-session-affinity",
  "x-parent-session-id",
  // opencode-internal request id / trace id (not part of the public surface
  // but worth keeping out of the fingerprint if any layer ever adds one).
  "x-request-id",
  "x-trace-id",
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const sortObjectKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortObjectKeys)
  if (!isRecord(value)) return value
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
  const out: Record<string, unknown> = {}
  for (const [k, v] of entries) out[k] = sortObjectKeys(v)
  return out
}

const stableStringify = (value: unknown): string => JSON.stringify(sortObjectKeys(value))

const normalizeHeaders = (headers: Record<string, string> | undefined): Record<string, string> => {
  if (!headers) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase()
    if (FINGERPRINT_HEADER_EXCLUDE.has(lower)) continue
    if (!CACHE_RELEVANT_HEADER_KEYS.includes(lower) && !lower.startsWith("x-opencode-")) {
      // Drop headers that are known not to affect prompt caching. This is a
      // safety net for future headers; the explicit list is the source of truth.
      continue
    }
    out[lower] = v
  }
  return out
}

const canonicalizeTools = (tools: Record<string, Tool>): ReadonlyArray<CanonicalTool> => {
  return Object.entries(tools)
    .map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name))
}

export const CanonicalRequest = Schema.Struct({
  model: Schema.Struct({
    providerID: Schema.String,
    modelID: Schema.String,
    apiID: Schema.String,
    variant: Schema.optional(Schema.String),
  }),
  system: Schema.Array(Schema.String),
  messages: Schema.Array(Schema.Unknown),
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.String),
      inputSchema: Schema.Unknown,
    }),
  ),
  toolChoice: Schema.optional(Schema.Literals(["auto", "required", "none"])),
  params: Schema.Struct({
    temperature: Schema.optional(Schema.Number),
    topP: Schema.optional(Schema.Number),
    topK: Schema.optional(Schema.Number),
    maxOutputTokens: Schema.optional(Schema.Number),
    options: Schema.Record(Schema.String, Schema.Unknown),
  }),
  headers: Schema.Record(Schema.String, Schema.String),
  promptCacheKey: Schema.optional(Schema.String),
})
export type CanonicalRequest = Types.DeepMutable<Schema.Schema.Type<typeof CanonicalRequest>>

export type CanonicalTool = {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: unknown
}

export type CanonicalParams = {
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly options: Record<string, unknown>
}

export type CanonicalModel = {
  readonly providerID: string
  readonly modelID: string
  readonly apiID: string
  readonly variant?: string
}

export type CanonicalCanonical = {
  readonly model: CanonicalModel
  readonly system: readonly string[]
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly CanonicalTool[]
  readonly toolChoice: "auto" | "required" | "none" | undefined
  readonly params: CanonicalParams
  readonly headers: Record<string, string>
  readonly promptCacheKey?: string
}

export type PreparedInvocation = {
  readonly sessionID: string
  readonly userID: string
  readonly assistantID: string
  readonly provider: { providerID: string; modelID: string; variant?: string }
  readonly fingerprint: string
  readonly promptCacheKey?: string
  readonly createdAt: number
  readonly ttlMs: number
  // Low-level request factory. Do not call directly outside LLM.streamPrepared();
  // streamPrepared owns abort, provider request watchdog, and timeout-to-error conversion.
  readonly run: (abort: AbortSignal) => Stream.Stream<LLMEvent, unknown>
  readonly canonical: CanonicalCanonical
}

export const computeFingerprint = (canonical: CanonicalCanonical): string => {
  const sortedTools = [...canonical.tools].toSorted((a, b) => a.name.localeCompare(b.name))
  const normalizedHeaders = normalizeHeaders(canonical.headers)
  const payload = {
    model: canonical.model,
    system: canonical.system,
    messages: canonical.messages,
    tools: sortedTools,
    toolChoice: canonical.toolChoice,
    params: canonical.params,
    headers: normalizedHeaders,
    promptCacheKey: canonical.promptCacheKey,
  }
  return createHash("sha256").update(stableStringify(payload)).digest("hex")
}

// Helper used by `llm.ts` to assemble the canonical request from the opencode
// session view. Kept here so both `prepare` and the `retry-exact` canary use
// the same exact logic.
export const buildCanonical = (input: {
  readonly model: { providerID: string; modelID: string; apiID: string; variant?: string }
  readonly system: readonly string[]
  readonly messages: readonly ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly toolChoice: "auto" | "required" | "none" | undefined
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, unknown>
  }
  readonly headers: Record<string, string> | undefined
  readonly promptCacheKey?: string
}): CanonicalCanonical => {
  return {
    model: input.model,
    system: [...input.system],
    messages: [...input.messages],
    tools: canonicalizeTools(input.tools),
    toolChoice: input.toolChoice,
    params: {
      ...(input.params.temperature === undefined ? {} : { temperature: input.params.temperature }),
      ...(input.params.topP === undefined ? {} : { topP: input.params.topP }),
      ...(input.params.topK === undefined ? {} : { topK: input.params.topK }),
      ...(input.params.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.params.maxOutputTokens }),
      options: input.params.options,
    },
    headers: normalizeHeaders(input.headers),
    ...(input.promptCacheKey ? { promptCacheKey: input.promptCacheKey } : {}),
  }
}

export const computeFingerprintForRequest = (
  input: Parameters<typeof buildCanonical>[0],
): string => computeFingerprint(buildCanonical(input))

export * as LLMInvocation from "./invocation"

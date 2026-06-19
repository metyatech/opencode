import type { Auth } from "@/auth"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { asSchema, type ModelMessage, type Tool } from "ai"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { FetchHttpClient } from "effect/unstable/http"
import { tool as nativeTool, ToolFailure, type JsonSchema, type LLMEvent } from "@opencode-ai/llm"
import type { LLMClientShape } from "@opencode-ai/llm/route"
import { LLMNative } from "./native-request"

export type RuntimeStatus =
  | { readonly type: "supported"; readonly apiKey: string; readonly baseURL?: string }
  | { readonly type: "unsupported"; readonly reason: string }

/**
 * Native runtime handles the prepare/run split for the native LLMClient
 * path. `prepare` resolves the runtime support and builds the
 * per-call stream factory; `run` invokes the factory with a fresh
 * `AbortSignal` and a freshly-resolved HTTP fetch override, so each
 * attempt produces a new request, a new stream, and a new
 * AbortSignal — and the body that hits the wire is byte-identical
 * across attempts because `prepare` captured every cache-relevant
 * input (model, messages, tools, headers, provider options,
 * temperature, topP, topK, maxOutputTokens).
 */
export type StreamResult =
  | { readonly type: "supported"; readonly stream: Stream.Stream<LLMEvent, unknown> }
  | { readonly type: "unsupported"; readonly reason: string }

type StreamInput = {
  readonly model: Provider.Model
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly llmClient: LLMClientShape
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly toolChoice?: "auto" | "required" | "none"
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: Record<string, any>
  readonly headers: Record<string, string>
  readonly abort: AbortSignal
}

/**
 * Result of `prepare` — captures every cache-relevant input and
 * exposes a `run(abort)` factory that produces a fresh
 * `Stream.Stream<LLMEvent>` per call. Each `run` invocation creates
 * a new HTTP request, so the body is identical but the transport
 * is not reused.
 */
export type PreparedNative =
  | {
      readonly type: "supported"
      readonly apiKey: string
      readonly baseURL?: string
      readonly fetch: typeof globalThis.fetch | undefined
      readonly run: (abort: AbortSignal) => Stream.Stream<LLMEvent, unknown>
    }
  | { readonly type: "unsupported"; readonly reason: string }

export function status(input: Pick<StreamInput, "model" | "provider" | "auth">): RuntimeStatus {
  return statusWithFetch(input, providerFetch(input))
}

function statusWithFetch(
  input: Pick<StreamInput, "model" | "provider" | "auth">,
  fetch: typeof globalThis.fetch | undefined,
): RuntimeStatus {
  const providerID = input.model.providerID
  if (providerID !== "openai" && providerID !== "anthropic" && !providerID.startsWith("opencode"))
    return { type: "unsupported", reason: "provider is not openai, opencode, or anthropic" }
  const npm = input.model.api.npm
  if (npm !== "@ai-sdk/openai" && npm !== "@ai-sdk/openai-compatible" && npm !== "@ai-sdk/anthropic")
    return { type: "unsupported", reason: "provider package is not OpenAI, OpenAI-compatible, or Anthropic" }
  if (input.auth?.type === "oauth" && !(input.provider.id === "openai" && fetch)) {
    return { type: "unsupported", reason: "OAuth auth requires a provider fetch override" }
  }

  const apiKey = typeof input.provider.options.apiKey === "string" ? input.provider.options.apiKey : input.provider.key
  if (!apiKey) return { type: "unsupported", reason: "API key is not configured" }

  return {
    type: "supported",
    apiKey,
    baseURL: typeof input.provider.options.baseURL === "string" ? input.provider.options.baseURL : undefined,
  }
}

/**
 * Resolve the runtime support and capture every cache-relevant
 * input. The returned `PreparedNative.run` produces a fresh
 * `Stream.Stream<LLMEvent>` per call so retry attempts each get
 * their own request body, decoder, and `AbortSignal`.
 */
export function prepare(
  input: Omit<StreamInput, "abort">,
): PreparedNative {
  const fetch = providerFetch(input)
  const current = statusWithFetch(input, fetch)
  if (current.type === "unsupported") return current

  const request = LLMNative.request({
    model: input.model,
    apiKey: current.apiKey,
    baseURL: current.baseURL,
    messages: ProviderTransform.message(input.messages, input.model, input.providerOptions ?? {}),
    toolChoice: input.toolChoice,
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
    maxOutputTokens: input.maxOutputTokens,
    providerOptions: ProviderTransform.providerOptions(input.model, input.providerOptions ?? {}),
    headers: { ...providerHeaders(input.provider.options.headers), ...input.headers },
  })

  return {
    ...current,
    fetch,
    // Each invocation creates a new `llmClient.stream` call, which
    // in turn issues a new HTTP request. The body is identical
    // across attempts because `request` is captured from the
    // cache-relevant inputs that were passed to `prepare`.
    run: (abort: AbortSignal) => {
      const tools = nativeTools(input.tools, {
        messages: input.messages,
        abort,
      })
      // The per-attempt AbortSignal is wired directly into the provider
      // HTTP stream's lifecycle via `Stream.interruptWhen`. When the
      // signal aborts, the stream is interrupted, which interrupts the
      // fiber running `RequestExecutor`'s `HttpClient.execute` — Effect's
      // HttpClient converts that interruption into a `fetch` AbortController
      // abort, so the in-flight provider request is torn down. This makes
      // the AbortSignal an explicit teardown trigger for the provider
      // request rather than relying solely on ambient fiber interruption.
      const stream = input.llmClient
        .stream({
          request,
          tools,
          abortSignal: abort,
        })
        .pipe(Stream.interruptWhen(abortToEffect(abort)))
      return fetch
        ? stream.pipe(Stream.provideService(FetchHttpClient.Fetch, fetch))
        : stream
    },
  }
}

/**
 * Backwards-compatible wrapper kept for callers that want a
 * single-shot stream from a one-off `StreamInput`. New callers
 * MUST use `prepare` + `run` so that retry attempts each get
 * their own request body.
 */
export function stream(input: StreamInput): StreamResult {
  const prepared = prepare(input)
  if (prepared.type === "unsupported") return prepared
  return { ...prepared, stream: prepared.run(input.abort) }
}

// Bridges a web `AbortSignal` into an Effect that succeeds the moment the
// signal aborts. Used with `Stream.interruptWhen` so the per-attempt abort
// deterministically tears down the provider HTTP stream.
export function abortToEffect(signal: AbortSignal): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void)
      return
    }
    const onAbort = () => resume(Effect.void)
    signal.addEventListener("abort", onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })
}

function providerFetch(input: Pick<StreamInput, "provider" | "auth">): typeof globalThis.fetch | undefined {
  if (input.provider.id !== "openai" || input.auth?.type !== "oauth") return undefined
  const value: unknown = input.provider.options.fetch
  if (typeof value !== "function") return undefined
  return value as typeof globalThis.fetch
}

function providerHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function nativeSchema(value: unknown): JsonSchema {
  if (!value || typeof value !== "object") return { type: "object", properties: {} }
  if ("jsonSchema" in value && value.jsonSchema && typeof value.jsonSchema === "object")
    return value.jsonSchema as JsonSchema
  return asSchema(value as Parameters<typeof asSchema>[0]).jsonSchema as JsonSchema
}

export function nativeTools(tools: Record<string, Tool>, input: Pick<StreamInput, "messages" | "abort">) {
  return Object.fromEntries(
    Object.entries(tools).map(([name, item]) => [
      name,
      // Tool execution remains opencode-owned. The native runtime only adapts
      // the @opencode-ai/llm tool call back into the AI SDK Tool.execute shape.
      nativeTool({
        description: item.description ?? "",
        jsonSchema: nativeSchema(item.inputSchema),
        execute: (args: unknown, ctx) =>
          Effect.tryPromise({
            try: () => {
              if (!item.execute) throw new Error(`Tool has no execute handler: ${name}`)
              return item.execute(args, {
                toolCallId: ctx?.id ?? name,
                messages: input.messages,
                abortSignal: input.abort,
              })
            },
            catch: (error) => new ToolFailure({ message: errorMessage(error), error }),
          }),
      }),
    ]),
  )
}

export * as LLMNativeRuntime from "./native-runtime"

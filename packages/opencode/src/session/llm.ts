import { Provider } from "@/provider/provider"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import * as Log from "@opencode-ai/core/util/log"
import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import type { LLMEvent } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import type { LLMClientService } from "@opencode-ai/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Bus } from "@/bus"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"
import { withProviderRequestWatchdog } from "./llm/provider-request-watchdog"
import {
  buildCanonical,
  computeFingerprint,
  type CanonicalCanonical,
  type PreparedInvocation,
} from "./llm/invocation"

export type { PreparedInvocation } from "./llm/invocation"

// Default lifetime stamped onto a `PreparedInvocation` for observability of how
// long a prepared stream remains meaningful. Not enforced by `prepare` /
// `streamPrepared` themselves.
const DEFAULT_TTL_MS = 30 * 60 * 1000

const log = Log.create({ service: "llm" })
export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

export type StreamInput = {
  user: MessageV2.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: Permission.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
  readonly prepare: (
    input: StreamInput,
  ) => Effect.Effect<PreparedInvocation, Auth.AuthError | Provider.ModelNotFoundError, never>
  readonly streamPrepared: (prepared: PreparedInvocation) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

export const use = serviceUse(Service)

// Provider families that use a session-stable `prompt_cache_key` for implicit
// prompt caching. Resolved by the opencode provider in `LLMRequestPrep` and
// re-exposed on the `PreparedInvocation` for visibility to downstream observers.
const SESSION_AFFINITY_HEADER = "x-session-affinity"

const resolvePromptCacheKey = (
  model: Provider.Model,
  sessionID: string,
  headers: Record<string, string>,
): string | undefined => {
  const providerID = model.providerID
  if (providerID === "openai" || providerID === "opencode" || providerID.startsWith("opencode-")) {
    // OpenAI Responses uses `prompt_cache_key` (camelCase) at the wire level;
    // the opencode provider sets it through the x-opencode-session header.
    if (headers["x-opencode-session"] || providerID.startsWith("opencode")) {
      return sessionID
    }
    if (providerID === "openai") {
      // Non-opencode OpenAI deployments honor the session affinity header as
      // the cache key — this is the legacy behavior.
      if (headers[SESSION_AFFINITY_HEADER]) return sessionID
    }
  }
  if (headers[SESSION_AFFINITY_HEADER]) return sessionID
  return undefined
}

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | LLMClientService
  | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service

    // --- Preparation ----------------------------------------------------------
    // The `prepare` step captures every value that contributes to the provider
    // request body so a retry can replay it without re-deriving any of the
    // inputs (system prompt, tool schema, headers, model choice, params). This
    // is the load-bearing step for prompt-cache hits on retry.
    const prepare = Effect.fn("LLM.prepare")(function* (input: StreamInput) {
      const l = log
        .clone()
        .tag("providerID", input.model.providerID)
        .tag("modelID", input.model.id)
        .tag("session.id", input.sessionID)
        .tag("small", (input.small ?? false).toString())
        .tag("agent", input.agent.name)
        .tag("mode", input.agent.mode)
      l.info("prepare", {
        modelID: input.model.id,
        providerID: input.model.providerID,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
      })

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: new AbortController().signal,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const bridge = yield* EffectBridge.make()
        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionID.ascending()
          let unsub: (() => void) | undefined
          try {
            unsub = Bus.subscribe(Permission.Event.Replied, (evt) => {
              if (evt.properties.requestID === id) void evt.properties.reply
            })
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            unsub?.()
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      const promptCacheKey = resolvePromptCacheKey(input.model, input.sessionID, prepared.headers)

      const canonical: CanonicalCanonical = buildCanonical({
        model: {
          providerID: input.model.providerID,
          modelID: input.model.id,
          apiID: input.model.api.id,
          ...(input.user.model.variant ? { variant: input.user.model.variant } : {}),
        },
        system: prepared.system,
        messages: prepared.messages,
        tools: prepared.tools,
        toolChoice: input.toolChoice,
        params: {
          ...(prepared.params.temperature === undefined ? {} : { temperature: prepared.params.temperature }),
          ...(prepared.params.topP === undefined ? {} : { topP: prepared.params.topP }),
          ...(prepared.params.topK === undefined ? {} : { topK: prepared.params.topK }),
          ...(prepared.params.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: prepared.params.maxOutputTokens }),
          options: prepared.params.options,
        },
        headers: prepared.headers,
        ...(promptCacheKey ? { promptCacheKey } : {}),
      })

      const fingerprint = computeFingerprint(canonical)

      // Decide the runtime ONCE during prepare; the run closure below reuses
      // the same selection so retries land on the same adapter path.
      // For the native runtime, `prepare` captures every cache-relevant
      // input and exposes a `run(abort)` factory that issues a new
      // request, decoder, and stream per call — so each retry attempt
      // has a fresh AbortSignal and a fresh HTTP request, but the
      // body that hits the wire is byte-identical.
      let runtime: PreparedRuntime
      if (flags.experimentalNativeLlm) {
        const native = LLMNativeRuntime.prepare({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: prepared.params.maxOutputTokens,
          providerOptions: prepared.params.options,
          headers: prepared.headers,
        })
        if (native.type === "supported") {
          yield* Effect.logInfo("llm runtime selected").pipe(
            Effect.annotateLogs({
              "llm.runtime": "native",
              "llm.provider": input.model.providerID,
              "llm.model": input.model.id,
            }),
          )
          // `run(abort)` creates a fresh stream and request per call.
          // The per-attempt AbortController is owned by `streamPrepared`
          // below.
          runtime = { type: "native", factory: native.run }
        } else {
          yield* Effect.logInfo("llm runtime selected").pipe(
            Effect.annotateLogs({
              "llm.runtime": "ai-sdk",
              "llm.provider": input.model.providerID,
              "llm.model": input.model.id,
              "llm.native_unsupported_reason": native.reason,
            }),
          )
          l.info("native runtime unavailable; falling back to ai-sdk", { reason: native.reason })
          runtime = {
            type: "ai-sdk",
            factory: makeAISDKFactory({
              input,
              prepared,
              language: language as AISDKModel,
              cfg,
              telemetryTracer,
            }),
          }
        }
      } else {
        yield* Effect.logInfo("llm runtime selected").pipe(
          Effect.annotateLogs({
            "llm.runtime": "ai-sdk",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
          }),
        )
        runtime = {
          type: "ai-sdk",
          factory: makeAISDKFactory({
            input,
            prepared,
            language: language as AISDKModel,
            cfg,
            telemetryTracer,
          }),
        }
      }

      const createdAt = Date.now()

      const invocation: PreparedInvocation = {
        sessionID: input.sessionID,
        userID: input.user.id,
        assistantID: "", // populated by the processor on publish
        provider: {
          providerID: input.model.providerID,
          modelID: input.model.id,
          ...(input.user.model.variant ? { variant: input.user.model.variant } : {}),
        },
        fingerprint,
        ...(promptCacheKey ? { promptCacheKey } : {}),
        createdAt,
        ttlMs: DEFAULT_TTL_MS,
        run: (abort) => runtime.factory(abort),
        canonical,
      }

      return invocation
    })

    // --- streamPrepared -------------------------------------------------------
    // The only safe entry point for executing a `PreparedInvocation`. Owns
    // the full per-attempt lifecycle:
    //   - a fresh `AbortController` per call (released — and therefore
    //     aborted — when the returned stream's scope closes, so a consumer
    //     fiber interrupt always reaches the in-flight provider request),
    //   - the provider request watchdog, which converts a silent stall
    //     (e.g. after a provider quota error) into a typed
    //     `ProviderRequestTimeoutError` stream failure instead of hanging
    //     forever,
    //   - `prepared.run(...)`'s raw stream, which is otherwise a low-level
    //     request factory and must not be invoked directly by callers.
    // Every caller — normal prompts, exact replay, and any future prepared
    // replay path — goes through this function and therefore always gets
    // watchdog coverage.
    const streamPrepared: Interface["streamPrepared"] = (prepared) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )
            const cfg = yield* config.get()
            const timeoutMs = cfg.experimental?.provider_request_timeout_ms ?? 0
            return withProviderRequestWatchdog(prepared.run(ctrl.signal), {
              providerID: prepared.provider.providerID,
              modelID: prepared.provider.modelID,
              timeoutMs,
              abort: ctrl,
            })
          }),
        ),
      )

    // --- stream (back-compat) -------------------------------------------------
    // For callers that want a one-shot stream (not retries) we provide the
    // historical `stream(input)` entry point. It is a thin wrapper over
    // `prepare` + `streamPrepared`; watchdog/abort ownership lives entirely
    // in `streamPrepared`, so this must not duplicate any of it.
    const stream: Interface["stream"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const prepared = yield* prepare(input)
          return streamPrepared(prepared)
        }),
      )

    return Service.of({ stream, prepare, streamPrepared })
  }),
)

// Factory that returns a fresh AI SDK streamText result per attempt. The
// returned factory is what the PreparedInvocation.run closure calls.
type PreparedRuntime =
  | { type: "ai-sdk"; factory: (abort: AbortSignal) => Stream.Stream<LLMEvent, unknown> }
  | { type: "native"; factory: (abort: AbortSignal) => Stream.Stream<LLMEvent, unknown> }

// The tracer proxy produced in `prepare` matches the AI SDK's
// `experimental_telemetry.tracer` type. We keep it loose here so the
// surrounding prepare/run code can hand the value back into streamText
// without an extra cast at the call site.
type TelemetryTracer = NonNullable<
  NonNullable<Parameters<typeof streamText>[0]["experimental_telemetry"]>["tracer"]
>

// `wrapLanguageModel` accepts `LanguageModelV3` from `@ai-sdk/provider`,
// which the `ai` re-export doesn't surface directly. We pull the type out
// of `wrapLanguageModel`'s parameter list to avoid a hand-rolled cast.
type AISDKModel = Parameters<typeof wrapLanguageModel>[0]["model"]

function makeAISDKFactory(input: {
  readonly input: StreamInput
  readonly prepared: LLMRequestPrep.Prepared
  readonly language: AISDKModel
  readonly cfg: Config.Info
  readonly telemetryTracer: TelemetryTracer | undefined
}): (abort: AbortSignal) => Stream.Stream<LLMEvent, unknown> {
  const l = log.clone().tag("providerID", input.input.model.providerID).tag("modelID", input.input.model.id)

  return (abort) => {
    // Build a fresh streamText result on every attempt. AI SDK performs the
    // HTTP request when the result is consumed, so building fresh per
    // attempt + sharing the same configuration => byte-identical body.
    const result = streamText({
      onError(error) {
        l.error("stream error", { error })
      },
      async experimental_repairToolCall(failed) {
        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && input.prepared.tools[lower]) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          }),
          toolName: "invalid",
        }
      },
      temperature: input.prepared.params.temperature,
      topP: input.prepared.params.topP,
      topK: input.prepared.params.topK,
      providerOptions: ProviderTransform.providerOptions(input.input.model, input.prepared.params.options),
      activeTools: Object.keys(input.prepared.tools).filter((x) => x !== "invalid"),
      tools: input.prepared.tools,
      toolChoice: input.input.toolChoice,
      maxOutputTokens: input.prepared.params.maxOutputTokens,
      abortSignal: abort,
      headers: input.prepared.headers,
      maxRetries: input.input.retries ?? 0,
      messages: input.prepared.messages,
      model: wrapLanguageModel({
        model: input.language,
        middleware: [
          {
            specificationVersion: "v3" as const,
            async transformParams(args) {
              if (args.type === "stream") {
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(
                  args.params.prompt,
                  input.input.model,
                  input.prepared.messageTransformOptions,
                )
              }
              return args.params
            },
          },
        ],
      }),
      experimental_telemetry: {
        isEnabled: input.cfg.experimental?.openTelemetry,
        functionId: "session.llm",
        tracer: input.telemetryTracer,
        metadata: {
          userId: input.cfg.username ?? "unknown",
          sessionId: input.input.sessionID,
        },
      },
    })

    const state = LLMAISDK.adapterState()
    return Stream.fromAsyncIterable(result.fullStream, (e) =>
      e instanceof Error ? e : new Error(String(e)),
    ).pipe(
      Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
      Stream.flatMap((events) => Stream.fromIterable(events)),
    )
  }
}

export const layer = live.pipe(Layer.provide(Permission.defaultLayer))

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(
      LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
    ),
    Layer.provide(RuntimeFlags.defaultLayer),
  ),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

// The existing namespace contract is preserved through the self-reexport at
// the bottom of this file (`export * as LLM from "./llm"`). The new prepare
// / streamPrepared surface lives on the `LLM.Service` interface and the
// `PreparedInvocation` type is available via a direct import from
// `@/session/llm/invocation`.

export * as LLM from "./llm"

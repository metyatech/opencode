import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import * as Stream from "effect/Stream"
import type { LLMEvent } from "@opencode-ai/llm"
import { LLM } from "../../../src/session/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageV2 } from "../../../src/session/message-v2"
import { testEffect } from "../../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LLM.defaultLayer,
    Provider.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Auth.defaultLayer,
    Config.defaultLayer,
    LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
    RuntimeFlags.defaultLayer,
  ),
)

// A minimal `PreparedInvocation` whose `run` never emits an event. This
// stands in for a provider quota error followed by a silent SDK/provider
// stall: no normalized `LLMEvent` ever arrives, so only the watchdog inside
// `LLM.streamPrepared` can turn the stall into a typed stream failure.
const makeNeverPrepared = (): LLM.PreparedInvocation => ({
  sessionID: "ses_watchdog",
  userID: "msg_user",
  assistantID: "msg_assistant",
  provider: { providerID: "test-provider", modelID: "test-model" },
  fingerprint: "fp-watchdog",
  createdAt: Date.now(),
  ttlMs: 1_800_000,
  run: () => Stream.never as Stream.Stream<LLMEvent, unknown>,
  canonical: {
    model: { providerID: "test-provider", modelID: "test-model", apiID: "test-model" },
    system: [],
    messages: [],
    tools: [],
    toolChoice: undefined,
    params: { options: {} },
    headers: {},
  },
})

describe("LLM.streamPrepared watchdog coverage", () => {
  it.instance(
    "fails with ProviderRequestTimeoutError when the prepared invocation never emits an event",
    () =>
      Effect.gen(function* () {
        const svc = yield* LLM.Service
        const prepared = makeNeverPrepared()

        const exit = yield* svc.streamPrepared(prepared).pipe(Stream.runDrain, Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) return
        const squashed = Cause.squash(exit.cause)
        expect(MessageV2.ProviderRequestTimeoutError.isInstance(squashed)).toBe(true)
      }),
    {
      config: () => ({ experimental: { provider_request_timeout_ms: 50 } }),
    },
  )

  it.instance(
    "does not time out when provider_request_timeout_ms is unset (watchdog disabled)",
    () =>
      Effect.gen(function* () {
        const svc = yield* LLM.Service
        const events: LLMEvent[] = []
        const prepared: LLM.PreparedInvocation = {
          ...makeNeverPrepared(),
          run: () =>
            Stream.fromIterable([
              { type: "step-start", index: 0 },
              { type: "finish", reason: "stop" },
            ] as unknown as LLMEvent[]),
        }

        yield* svc.streamPrepared(prepared).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              events.push(event)
            }),
          ),
          Stream.runDrain,
        )

        expect(events.map((e) => e.type)).toStrictEqual(["step-start", "finish"])
      }),
    {
      config: () => ({}),
    },
  )
})

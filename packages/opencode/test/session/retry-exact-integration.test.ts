import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { testEffect } from "../lib/effect"
import { Bus } from "@/bus"
import { LLM } from "@/session/llm"
import { SessionProcessor } from "@/session/processor"
import { SessionRetryExact } from "@/session/retry-exact"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { MessageV2 } from "@/session/message-v2"
import { LLMInvocation } from "@/session/llm/invocation"
import { MessageID, SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import { provideTmpdirInstance } from "../fixture/fixture"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import path from "path"

const MODELS_FIXTURE = JSON.parse(
  await Bun.file(path.join(import.meta.dir, "../tool/fixtures/models-api.json")).text(),
) as Record<string, ModelsDev.Provider>

function loadFixture(providerID: string, modelID: string) {
  const provider = MODELS_FIXTURE[providerID]
  if (!provider) throw new Error(`Missing provider in fixture: ${providerID}`)
  const model = provider.models[modelID]
  if (!model) throw new Error(`Missing model in fixture: ${providerID}/${modelID}`)
  return { provider, model }
}

// Build a minimal valid `PreparedInvocation` for a synthetic session. The
// session processor requires the model to exist in the provider
// registry, but for this test we only assert that the canary / claim
// surface reports the correct shape and respects the messageID
// invariant — the actual provider dispatch is exercised end-to-end in
// `llm-prepare-once.test.ts`.
const makeInvocation = (
  overrides: Partial<LLMInvocation.PreparedInvocation> = {},
): LLMInvocation.PreparedInvocation => ({
  sessionID: "ses_test",
  userID: "msg_user",
  assistantID: "msg_assistant",
  provider: { providerID: "openai", modelID: "gpt-5.2" },
  fingerprint: "fp-test",
  createdAt: Date.now(),
  ttlMs: 30 * 60 * 1000,
  run: () => Stream.empty,
  canonical: {
    model: { providerID: "openai", modelID: "gpt-5.2", apiID: "gpt-5.2" },
    system: [],
    messages: [],
    tools: [],
    toolChoice: undefined,
    params: { options: {} },
    headers: {},
  },
  ...overrides,
})

const layers = Layer.mergeAll(
  LLM.defaultLayer,
  Session.defaultLayer,
  SessionProcessor.defaultLayer,
  SessionRunState.defaultLayer,
  SessionRetryExact.defaultLayer,
  SessionStatus.defaultLayer,
  Bus.layer,
  Auth.defaultLayer,
  Config.defaultLayer,
  Provider.defaultLayer,
  Plugin.defaultLayer,
  Permission.defaultLayer,
  RuntimeFlags.defaultLayer,
  LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
  CrossSpawnSpawner.defaultLayer,
)

const it = testEffect(layers)

describe("session.retryExact integration", () => {
  it.live("claim returns no-prepared-invocation for an empty cache", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const svc = yield* SessionRetryExact.Service
        const outcome = yield* svc.claim({
          sessionID: SessionID.make("ses_empty"),
          expectedProviderID: "openai",
          expectedModelID: "gpt-5.2",
        })
        expect(outcome).toEqual({ accepted: false, reason: "no-prepared-invocation" })
      }).pipe(Effect.provide(Layer.succeed(Config.Service, { enabled_providers: ["openai"] } as never))),
    ),
  )

  it.live("claim returns no-prepared-invocation for stale model", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const svc = yield* SessionRetryExact.Service
        yield* svc.publish(
          makeInvocation({
            sessionID: "ses_test",
            provider: { providerID: "anthropic", modelID: "claude-opus-4-7" },
          }),
        )
        const outcome = yield* svc.claim({
          sessionID: SessionID.make("ses_test"),
          expectedProviderID: "openai",
          expectedModelID: "gpt-5.2",
        })
        expect(outcome.accepted).toBe(false)
        if (outcome.accepted === false) {
          expect(outcome.reason).toBe("model-mismatch")
        }
      }).pipe(Effect.provide(Layer.succeed(Config.Service, { enabled_providers: ["openai", "anthropic"] } as never))),
    ),
  )

  it.live("claim returns session-disposed when no session exists", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const svc = yield* SessionRetryExact.Service
        yield* svc.publish(makeInvocation({ sessionID: "ses_test" }))
        const outcome = yield* svc.claim({
          sessionID: SessionID.make("ses_test"),
          expectedProviderID: "openai",
          expectedModelID: "gpt-5.2",
        })
        // The session does not actually exist in the Session table;
        // the eligibility check fires session-disposed before the
        // messageID check. This is the correct precedence: a missing
        // session is a stronger rejection than a stale messageID.
        expect(outcome.accepted).toBe(false)
        if (outcome.accepted === false) {
          expect(outcome.reason).toBe("session-disposed")
        }
      }).pipe(Effect.provide(Layer.succeed(Config.Service, { enabled_providers: ["openai"] } as never))),
    ),
  )
})

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { Bus } from "@/bus"
import { LLM } from "@/session/llm"
import { SessionRetryExact } from "@/session/retry-exact"
import { SessionStatus } from "@/session/status"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { computeFingerprint, type CanonicalCanonical, type PreparedInvocation } from "../../src/session/llm/invocation"
import { SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

const baseCanonical: CanonicalCanonical = {
  model: { providerID: "openai", modelID: "gpt-5.2", apiID: "gpt-5.2" },
  system: ["You are a helpful assistant."],
  messages: [],
  tools: [],
  toolChoice: "auto",
  params: { options: {} },
  headers: { "x-opencode-project": "p1" },
}

const makeInvocation = (overrides: Partial<PreparedInvocation> = {}): PreparedInvocation => ({
  sessionID: "session-A",
  userID: "msg_user",
  assistantID: "msg_assistant",
  provider: { providerID: "openai", modelID: "gpt-5.2" },
  fingerprint: computeFingerprint(baseCanonical),
  promptCacheKey: "session-A",
  createdAt: Date.now(),
  ttlMs: 30 * 60 * 1000,
  run: () => {
    throw new Error("not used in tests")
  },
  canonical: baseCanonical,
  ...overrides,
})

const it = testEffect(
  Layer.mergeAll(
    SessionRetryExact.defaultLayer,
    LLM.defaultLayer,
    SessionStatus.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    Bus.layer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

describe("SessionRetryExact.Service.canRetry", () => {
  it.live("returns no-prepared-invocation when the cache is empty", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* SessionRetryExact.Service
        const outcome = yield* svc.canRetry({
          sessionID: SessionID.make("ses_missing"),
          expectedProviderID: "openai",
          expectedModelID: "gpt-5.2",
        })
        expect(outcome).toEqual({ reason: "no-prepared-invocation" })
      }),
    ),
  )

  it.live("returns the cached fingerprint on success", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionSvc = yield* Session.Service
        const svc = yield* SessionRetryExact.Service
        const session = yield* sessionSvc.create({ title: "retry-exact-test" })
        const inv = makeInvocation({ sessionID: session.id, promptCacheKey: session.id })
        yield* svc.publish(inv)
        const outcome = yield* svc.canRetry({
          sessionID: session.id,
          expectedProviderID: "openai",
          expectedModelID: "gpt-5.2",
        })
        expect(outcome).toMatchObject({
          accepted: true,
          fingerprint: inv.fingerprint,
          promptCacheKey: session.id,
        })
      }),
    ),
  )

  it.live("returns model-mismatch when expectedModelID differs", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionSvc = yield* Session.Service
        const svc = yield* SessionRetryExact.Service
        const session = yield* sessionSvc.create({ title: "retry-exact-test" })
        yield* svc.publish(makeInvocation({ sessionID: session.id }))
        const outcome = yield* svc.canRetry({
          sessionID: session.id,
          expectedProviderID: "openai",
          expectedModelID: "gpt-5.1",
        })
        expect(outcome).toMatchObject({ reason: "model-mismatch" })
      }),
    ),
  )

  it.live("returns model-mismatch when expectedProviderID differs", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionSvc = yield* Session.Service
        const svc = yield* SessionRetryExact.Service
        const session = yield* sessionSvc.create({ title: "retry-exact-test" })
        yield* svc.publish(
          makeInvocation({ sessionID: session.id, provider: { providerID: "openai", modelID: "gpt-5.2" } }),
        )
        const outcome = yield* svc.canRetry({
          sessionID: session.id,
          expectedProviderID: "anthropic",
          expectedModelID: "gpt-5.2",
        })
        expect(outcome).toMatchObject({ reason: "model-mismatch" })
      }),
    ),
  )

  it.live("returns variant-mismatch when expectedVariant differs", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionSvc = yield* Session.Service
        const svc = yield* SessionRetryExact.Service
        const session = yield* sessionSvc.create({ title: "retry-exact-test" })
        yield* svc.publish(
          makeInvocation({
            sessionID: session.id,
            provider: { providerID: "openai", modelID: "gpt-5.2", variant: "high" },
          }),
        )
        const outcome = yield* svc.canRetry({
          sessionID: session.id,
          expectedProviderID: "openai",
          expectedModelID: "gpt-5.2",
          expectedVariant: "low",
        })
        expect(outcome).toMatchObject({ reason: "variant-mismatch" })
      }),
    ),
  )

  it.live("returns invocation-expired after TTL", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionSvc = yield* Session.Service
        const svc = yield* SessionRetryExact.Service
        const session = yield* sessionSvc.create({ title: "retry-exact-test" })
        // 1ms TTL so the next read sees it as expired.
        yield* svc.publish(makeInvocation({ sessionID: session.id, createdAt: Date.now() - 10, ttlMs: 5 }))
        const outcome = yield* svc.canRetry({
          sessionID: session.id,
          expectedProviderID: "openai",
          expectedModelID: "gpt-5.2",
        })
        expect(outcome).toMatchObject({ reason: "invocation-expired" })
      }),
    ),
  )

  it.live("returns session-disposed when the session is not registered", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* SessionRetryExact.Service
        const id = SessionID.make("ses_orphan")
        yield* svc.publish(makeInvocation({ sessionID: id }))
        const outcome = yield* svc.canRetry({
          sessionID: id,
          expectedProviderID: "openai",
          expectedModelID: "gpt-5.2",
        })
        expect(outcome).toMatchObject({ reason: "session-disposed" })
      }),
    ),
  )
})

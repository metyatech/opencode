import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import {
  DEFAULT_TTL_MS,
  emptyState,
  get,
  invalidate,
  isInvalidReason,
  peek,
  publish,
  type InvalidReason,
  type InvocationCacheState,
} from "../../src/session/llm/invocation-cache"
import { computeFingerprint, type CanonicalCanonical, type PreparedInvocation } from "../../src/session/llm/invocation"

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
  createdAt: Date.now(),
  ttlMs: DEFAULT_TTL_MS,
  run: () => {
    throw new Error("not used in tests")
  },
  canonical: baseCanonical,
  ...overrides,
})

const it = testEffect(CrossSpawnSpawner.defaultLayer)

describe("session.llm.invocation-cache.isInvalidReason", () => {
  test("accepts the documented reason set", () => {
    for (const reason of [
      "new-user-message",
      "compaction",
      "model-switch",
      "tool-started",
      "tool-result",
      "session-disposed",
      "ttl-expired",
      "retry-already-running",
    ] as InvalidReason[]) {
      expect(isInvalidReason(reason)).toBe(true)
    }
  })

  test("rejects unknown values", () => {
    expect(isInvalidReason("nope")).toBe(false)
    expect(isInvalidReason(undefined)).toBe(false)
    expect(isInvalidReason(42)).toBe(false)
  })
})

describe("session.llm.invocation-cache.publish", () => {
  it.effect("round-trips a published invocation", () =>
    Effect.gen(function* () {
      const state: InvocationCacheState = emptyState()
      const inv = makeInvocation({ sessionID: "s1" })
      yield* publish(state, inv)
      const got = yield* get(state, "s1")
      expect(got?.fingerprint).toBe(inv.fingerprint)
    }),
  )

  it.effect("returns undefined for an uncached session", () =>
    Effect.gen(function* () {
      const state: InvocationCacheState = emptyState()
      const got = yield* get(state, "missing")
      expect(got).toBeUndefined()
    }),
  )

  it.effect("publish is idempotent for the same session — latest wins", () =>
    Effect.gen(function* () {
      const state: InvocationCacheState = emptyState()
      const inv1 = makeInvocation({ sessionID: "s1", createdAt: 1000, fingerprint: "first" })
      const inv2 = makeInvocation({ sessionID: "s1", createdAt: 2000, fingerprint: "second" })
      yield* publish(state, inv1)
      yield* publish(state, inv2)
      const got = yield* get(state, "s1", 2000)
      expect(got?.fingerprint).toBe("second")
    }),
  )

  it.effect("concurrent get after publish returns the latest", () =>
    Effect.gen(function* () {
      const state: InvocationCacheState = emptyState()
      const inv = makeInvocation({ sessionID: "s1", fingerprint: "f1" })
      yield* publish(state, inv)
      const a = yield* get(state, "s1")
      const b = yield* get(state, "s1")
      const c = yield* get(state, "s1")
      expect([a, b, c].map((entry) => entry?.fingerprint)).toEqual(["f1", "f1", "f1"])
    }),
  )
})

describe("session.llm.invocation-cache TTL", () => {
  it.effect("get returns undefined after ttl and removes the entry", () =>
    Effect.gen(function* () {
      const state: InvocationCacheState = emptyState()
      const inv = makeInvocation({ sessionID: "s1", createdAt: 1000, ttlMs: 5000 })
      yield* publish(state, inv)
      // 5s + 1ms past creation: TTL exceeded.
      const got = yield* get(state, "s1", 1000 + 5000 + 1)
      expect(got).toBeUndefined()
      // The cache is now empty: the stale entry was removed.
      expect(peek(state, "s1")).toBeUndefined()
    }),
  )

  it.effect("get is still valid at exactly the TTL boundary", () =>
    Effect.gen(function* () {
      const state: InvocationCacheState = emptyState()
      const inv = makeInvocation({ sessionID: "s1", createdAt: 1000, ttlMs: 5000 })
      yield* publish(state, inv)
      const got = yield* get(state, "s1", 1000 + 5000)
      expect(got?.fingerprint).toBe(inv.fingerprint)
    }),
  )
})

describe("session.llm.invocation-cache.invalidate", () => {
  it.effect("removes the cached entry regardless of the reason", () =>
    Effect.gen(function* () {
      const state: InvocationCacheState = emptyState()
      yield* publish(state, makeInvocation({ sessionID: "s1" }))
      yield* invalidate(state, "s1", "new-user-message")
      expect(peek(state, "s1")).toBeUndefined()
      yield* publish(state, makeInvocation({ sessionID: "s1" }))
      yield* invalidate(state, "s1", "compaction")
      expect(peek(state, "s1")).toBeUndefined()
      yield* publish(state, makeInvocation({ sessionID: "s1" }))
      yield* invalidate(state, "s1", "session-disposed")
      expect(peek(state, "s1")).toBeUndefined()
    }),
  )
})

import { Context, Effect, Layer, Schema, Scope } from "effect"
import * as Stream from "effect/Stream"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Session } from "@/session/session"
import { LLM } from "@/session/llm"
import { LLMInvocation } from "@/session/llm/invocation"
import { LLMInvocationCache } from "@/session/llm/invocation-cache"
import { InstanceState } from "@/effect/instance-state"
import { SessionID, MessageID } from "@/session/schema"
import { SessionRunState } from "./run-state"
import { SessionStatus } from "./status"
import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"

// Rejection reasons. These are the values the public `canRetry` returns
// and the values the HTTP layer surfaces to the caller.
export const RetryExactRejectionReason = {
  values: [
    "no-prepared-invocation",
    "request-not-latest",
    "model-mismatch",
    "variant-mismatch",
    "invocation-expired",
    "new-user-message",
    "assistant-activity-observed",
    "tool-side-effect-risk",
    "retry-already-running",
    "session-disposed",
  ] as const,
} as const

export type RetryExactRejectionReason = (typeof RetryExactRejectionReason.values)[number]

export type RetryExactInput = {
  readonly sessionID: SessionID
  readonly messageID?: MessageID
  readonly expectedProviderID: string
  readonly expectedModelID: string
  readonly expectedVariant?: string
}

export const RetryExactRejection = Schema.Struct({
  reason: Schema.Literals(RetryExactRejectionReason.values),
  fingerprint: Schema.optional(Schema.String),
  promptCacheKey: Schema.optional(Schema.String),
})
export type RetryExactRejection = Schema.Schema.Type<typeof RetryExactRejection>

export const RetryExactAccepted = Schema.Struct({
  accepted: Schema.Literal(true),
  fingerprint: Schema.String,
  promptCacheKey: Schema.optional(Schema.String),
})
export type RetryExactAccepted = Schema.Schema.Type<typeof RetryExactAccepted>

export const RetryExactResult = Schema.Union([RetryExactAccepted, RetryExactRejection])
export type RetryExactResult = Schema.Schema.Type<typeof RetryExactResult>

export type RetryExactOutcome =
  | { readonly accepted: true; readonly fingerprint: string; readonly promptCacheKey?: string }
  | RetryExactRejection

// Bus payload for the `session.exactReplay` status event the processor (or
// external callers via retryExact) emit on every successful attempt.
export const ExactReplayPayload = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optional(Schema.String),
  fingerprint: Schema.String,
  promptCacheKey: Schema.optional(Schema.String),
  attempt: Schema.Number,
})
export type ExactReplayPayload = Schema.Schema.Type<typeof ExactReplayPayload>

export const ExactReplayEvent = BusEvent.define("session.exactReplay", ExactReplayPayload)

/**
 * Result of an atomic claim attempt. The HTTP handler calls `claim`
 * after a successful `SessionRunState.ensureRunning` block; the
 * busy-ness check inside the eligibility gate observes the claim and
 * prevents two simultaneous exact replays.
 */
export type ClaimOutcome =
  | { readonly accepted: true; readonly prepared: LLMInvocation.PreparedInvocation }
  | RetryExactRejection

export interface Interface {
  /**
   * Pure decision: is the prepared invocation eligible for an exact
   * replay? Performs the cache lookup, TTL check, provider/model
   * comparison, variant comparison, session check, and status / busy
   * check. Does NOT check the messageID. Does NOT claim the runner.
   */
  readonly canRetry: (input: RetryExactInput) => Effect.Effect<RetryExactOutcome, never>
  /**
   * Atomic claim: full eligibility check + return the
   * `PreparedInvocation` to drive. The HTTP layer MUST wrap this in
   * `SessionRunState.ensureRunning` so the busy-ness check observes
   * the claim. The messageID check is enforced here: a caller-supplied
   * `messageID` that does not match the prepared invocation's
   * userID is rejected as `request-not-latest`.
   */
  readonly claim: (input: RetryExactInput) => Effect.Effect<ClaimOutcome, never>
  // Internal hooks used by the processor. Not part of the public surface.
  readonly publish: (inv: LLMInvocation.PreparedInvocation) => Effect.Effect<void>
  readonly invalidate: (sessionID: SessionID, reason: LLMInvocationCache.InvalidReason) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRetryExact") {}

const live: Layer.Layer<
  Service,
  never,
  LLM.Service | Session.Service | SessionStatus.Service | SessionRunState.Service | Bus.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const sessionSvc = yield* Session.Service
    const statusSvc = yield* SessionStatus.Service
    const runStateSvc = yield* SessionRunState.Service
    const bus = yield* Bus.Service

    // The cache is per-directory; we keep an `InstanceState` of caches so
    // each open workspace has its own per-session map.
    const caches = yield* InstanceState.make(
      Effect.fn("SessionRetryExact.caches")(function* () {
        yield* Effect.sleep(0)
        return LLMInvocationCache.emptyState()
      }),
    )

    const getCache = Effect.fn("SessionRetryExact.getCache")(function* () {
      return yield* InstanceState.get(caches)
    })

    const publish = (inv: LLMInvocation.PreparedInvocation): Effect.Effect<void> =>
      Effect.gen(function* () {
        const state = yield* getCache()
        yield* LLMInvocationCache.publish(state, inv)
      })

    const invalidate = (sessionID: SessionID, reason: LLMInvocationCache.InvalidReason): Effect.Effect<void> =>
      Effect.gen(function* () {
        const state = yield* getCache()
        yield* LLMInvocationCache.invalidate(state, sessionID, reason)
      })

    const fingerprintOf = (state: LLMInvocationCache.InvocationCacheState, sessionID: SessionID) => {
      const inv = LLMInvocationCache.peek(state, sessionID)
      return inv
        ? {
            fingerprint: inv.fingerprint,
            ...(inv.promptCacheKey ? { promptCacheKey: inv.promptCacheKey } : {}),
          }
        : {}
    }

    const checkEligibility = Effect.fn("SessionRetryExact.checkEligibility")(function* (input: RetryExactInput) {
      const state = yield* getCache()
      const now = Date.now()
      const inv = LLMInvocationCache.peek(state, input.sessionID)
      if (!inv) {
        return { reason: "no-prepared-invocation" as const }
      }
      if (now - inv.createdAt > inv.ttlMs) {
        yield* LLMInvocationCache.invalidate(state, input.sessionID, "ttl-expired")
        return { reason: "invocation-expired" as const, ...fingerprintOf(state, input.sessionID) }
      }
      if (inv.provider.providerID !== input.expectedProviderID) {
        return { reason: "model-mismatch" as const, ...fingerprintOf(state, input.sessionID) }
      }
      if (inv.provider.modelID !== input.expectedModelID) {
        return { reason: "model-mismatch" as const, ...fingerprintOf(state, input.sessionID) }
      }
      if (input.expectedVariant !== undefined && inv.provider.variant !== input.expectedVariant) {
        return { reason: "variant-mismatch" as const, ...fingerprintOf(state, input.sessionID) }
      }
      if (inv.provider.variant !== undefined && input.expectedVariant === undefined) {
        // The prepared invocation has a variant but the caller did not
        // declare one — treat as variant mismatch to keep the wire body
        // stable.
        return { reason: "variant-mismatch" as const, ...fingerprintOf(state, input.sessionID) }
      }

      // Check live session state for activity since the prepared invocation.
      const session = yield* sessionSvc.get(input.sessionID).pipe(Effect.orElseSucceed(() => undefined))
      if (!session) {
        return { reason: "session-disposed" as const, ...fingerprintOf(state, input.sessionID) }
      }

      // A retry is already in flight?
      const status = yield* statusSvc.get(input.sessionID)
      if (status.type === "busy" || status.type === "retry") {
        return { reason: "retry-already-running" as const, ...fingerprintOf(state, input.sessionID) }
      }
      // The run-state's `assertNotBusy` is the canonical "is the runner
      // currently working" check. Calling it as a positive check is fine
      // — it succeeds if the session is idle, fails with `BusyError`
      // otherwise. We don't want to fail `canRetry` if the runner is
      // idle, so we catch the busy case and treat it as a rejection.
      const busy = yield* runStateSvc.assertNotBusy(input.sessionID).pipe(
        Effect.map((): boolean => false),
        Effect.orElseSucceed((): boolean => true),
      )
      if (busy) {
        return { reason: "retry-already-running" as const, ...fingerprintOf(state, input.sessionID) }
      }

      return {
        accepted: true as const,
        fingerprint: inv.fingerprint,
        ...(inv.promptCacheKey ? { promptCacheKey: inv.promptCacheKey } : {}),
      } as RetryExactOutcome
    })

    // --- canRetry (pure decision) ------------------------------------------
    // Public contract for `canRetry`. Returns either an `accepted` outcome
    // (carrying the fingerprint) or a typed rejection. No HTTP traffic
    // happens here.
    const canRetry = Effect.fn("SessionRetryExact.canRetry")(function* (input: RetryExactInput) {
      return yield* checkEligibility(input)
    })

    // --- claim (atomic) ----------------------------------------------------
    // Full eligibility check + return the `PreparedInvocation`. The HTTP
    // layer MUST wrap this in `SessionRunState.ensureRunning` so the
    // busy-ness check observes the claim. The messageID check is
    // enforced here: a caller-supplied `messageID` that does not match
    // the prepared invocation's `userID` is rejected as
    // `request-not-latest`.
    const claim = Effect.fn("SessionRetryExact.claim")(function* (input: RetryExactInput) {
      const outcome = yield* checkEligibility(input)
      if (!("accepted" in outcome)) return outcome
      const state = yield* getCache()
      const inv = LLMInvocationCache.peek(state, input.sessionID)
      if (!inv) return { reason: "no-prepared-invocation" as const }
      if (input.messageID !== undefined && inv.userID !== input.messageID) {
        return { reason: "request-not-latest" as const, ...fingerprintOf(state, input.sessionID) }
      }
      return { accepted: true as const, prepared: inv }
    })

    return Service.of({ canRetry, claim, publish, invalidate })
  }),
)

export const layer = live
export const defaultLayer = layer.pipe(
  Layer.provide(LLM.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(SessionRunState.defaultLayer),
  Layer.provide(Bus.layer),
)

export * as SessionRetryExact from "./retry-exact"

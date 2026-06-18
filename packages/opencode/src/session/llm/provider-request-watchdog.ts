import { Cause, Clock, Deferred, Effect, Exit, Fiber, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import type { LLMEvent } from "@opencode-ai/llm"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { ProviderRequestTimeoutError } from "../message-error"

const TimeoutPhase = Schema.Literals(["first_event", "stream_idle"])
export type TimeoutPhase = "first_event" | "stream_idle"

export type TimeoutInstance = InstanceType<typeof ProviderRequestTimeoutError>

/**
 * Clock abstraction. Tests inject a fake clock whose `sleep` returns a
 * `Deferred.await`-like Effect that resolves when the test advances time; the
 * live binding injects `Clock.currentTimeMillis` and a real `Effect.sleep`.
 */
export type WatchdogClock = {
  readonly now: () => number
  readonly sleep: (ms: number) => Effect.Effect<void>
}

export type WatchdogTimeoutEvent = {
  readonly phase: TimeoutPhase
  readonly timeoutMs: number
}

export type WatchdogActivityEvent = {
  readonly kind: "first" | "subsequent"
}

export type WatchdogOptions = {
  readonly timeoutMs: number
  readonly clock: WatchdogClock
  readonly onTimeout: (event: WatchdogTimeoutEvent) => Effect.Effect<void>
  readonly onActivity?: (event: WatchdogActivityEvent) => Effect.Effect<void>
}

/**
 * Conceptual states the watchdog transitions through while observing an LLM
 * event stream:
 *
 *   inactive                — `timeoutMs <= 0`; pass-through, no bookkeeping.
 *   awaiting-first-event    — subscription start; timer fires `first_event`
 *                             if no normalized event arrives in time.
 *   streaming               — at least one event seen; timer is re-armed to
 *                             `lastActivityAt + timeoutMs` on every activity
 *                             event and fires `stream_idle` if the deadline
 *                             passes with no activity.
 *   paused-for-tool         — a local (non-provider-executed) `tool-call`
 *                             is in flight. Timer is parked. The next
 *                             `step-start` resumes `streaming` and re-arms.
 *
 * Terminal transitions (step-finish, finish, provider-error, stream normal
 * end, stream failure, user cancel, scope end) all clear the timer and the
 * listener so a watchdog can never classify an already-finished stream as a
 * timeout.
 */
export type WatchdogState =
  | { readonly _tag: "inactive" }
  | { readonly _tag: "awaiting-first-event"; readonly lastActivityAt: number }
  | { readonly _tag: "streaming"; readonly lastActivityAt: number }
  | { readonly _tag: "paused-for-tool"; readonly lastActivityAt: number }
  | { readonly _tag: "fired"; readonly phase: TimeoutPhase }
  | { readonly _tag: "closed" }

/**
 * Effect an `LLMEvent` has on the watchdog state machine.
 */
export type EventEffect = "activity" | "pause-for-tool" | "resume-from-tool" | "terminal" | "noop"

export function classifyEvent(event: LLMEvent): EventEffect {
  switch (event.type) {
    case "step-start":
      return "resume-from-tool"
    case "text-start":
    case "text-delta":
    case "text-end":
    case "reasoning-start":
    case "reasoning-delta":
    case "reasoning-end":
    case "tool-input-start":
    case "tool-input-delta":
    case "tool-input-end":
      return "activity"
    case "tool-call":
      return event.providerExecuted === true ? "activity" : "pause-for-tool"
    case "tool-result":
      return event.providerExecuted === true ? "activity" : "noop"
    case "tool-error":
      return "noop"
    case "step-finish":
    case "finish":
    case "provider-error":
      return "terminal"
    default:
      return "noop"
  }
}

/**
 * Self-contained watchdog state machine. Tests drive it directly with a
 * fake clock; the live Stream wrapper wires it into the source stream.
 */
export type ProviderRequestWatchdog = {
  /**
   * Feed an `LLMEvent` into the state machine. Returns the resulting state,
   * whether the event was treated as activity, and (when armed) an Effect
   * that resolves when the active deadline elapses. Tests race the returned
   * Effect against the next event to drive determinism.
   */
  readonly handle: (event: LLMEvent) => {
    readonly state: WatchdogState
    readonly activity: boolean
    readonly deadline: Effect.Effect<void> | undefined
  }
  /** Read-only view of the current state. */
  readonly state: () => WatchdogState
  /**
   * Stop the timer and mark the watchdog closed. Idempotent. After this call
   * `handle(...)` is a no-op and the helper will never fire a timeout.
   */
  readonly cancel: () => void
  /**
   * Test-only accessor for the underlying deferred so the suite can advance
   * a fake clock deterministically. The live wrapper never reads this.
   */
  readonly _currentDeadline: () => Deferred.Deferred<void, never> | undefined
}

export function createProviderRequestWatchdog(options: WatchdogOptions): ProviderRequestWatchdog {
  const { clock, timeoutMs, onTimeout, onActivity } = options
  const disabled = !Number.isFinite(timeoutMs) || timeoutMs <= 0

  let state: WatchdogState = disabled
    ? { _tag: "inactive" }
    : { _tag: "awaiting-first-event", lastActivityAt: clock.now() }
  /**
   * Each arming creates a fresh Deferred so callers can race against the
   * deadline without subscribing to a single shared fiber. The fiber that
   * wakes it is held so we can interrupt it on cancel/re-arm.
   */
  let currentDeadline: Deferred.Deferred<void, never> | undefined
  let currentFiber: Fiber.Fiber<void, never> | undefined

  const cancelFiber = () => {
    if (currentFiber) {
      currentFiber.interruptUnsafe()
      currentFiber = undefined
    }
  }

  const armTimer = () => {
    cancelFiber()
    if (state._tag !== "awaiting-first-event" && state._tag !== "streaming") {
      currentDeadline = undefined
      return
    }
    const phase: TimeoutPhase = state._tag === "awaiting-first-event" ? "first_event" : "stream_idle"
    const deadlineAt = state.lastActivityAt + timeoutMs
    const remaining = Math.max(0, deadlineAt - clock.now())
    const deferred = Effect.runSync(Deferred.make<void, never>())
    currentDeadline = deferred
    currentFiber = Effect.runFork(
      clock
        .sleep(remaining)
        .pipe(
          Effect.andThen(Deferred.succeed(deferred, void 0)),
          // Transition the watchdog into `fired` *before* invoking the
          // consumer's onTimeout so the caller can synchronously observe
          // `watchdog.state()._tag === "fired"`.
          Effect.andThen(
            Effect.sync(() => {
              if (state._tag === "fired" || state._tag === "closed" || state._tag === "inactive") return
              state = { _tag: "fired", phase }
            }),
          ),
          Effect.andThen(onTimeout({ phase, timeoutMs })),
        ),
    )
  }

  const handle = (event: LLMEvent) => {
    if (state._tag === "closed" || state._tag === "fired" || state._tag === "inactive") {
      return { state, activity: false, deadline: undefined }
    }
    const effect = classifyEvent(event)
    if (effect === "activity") {
      const kind: "first" | "subsequent" = state._tag === "awaiting-first-event" ? "first" : "subsequent"
      state = { _tag: "streaming", lastActivityAt: clock.now() }
      armTimer()
      if (onActivity) Effect.runFork(onActivity({ kind }))
      return {
        state,
        activity: true,
        deadline: currentDeadline ? Deferred.await(currentDeadline) : undefined,
      }
    }
    if (effect === "pause-for-tool") {
      cancelFiber()
      currentDeadline = undefined
      state = { _tag: "paused-for-tool", lastActivityAt: clock.now() }
      return { state, activity: false, deadline: undefined }
    }
    if (effect === "resume-from-tool") {
      const kind: "first" | "subsequent" = state._tag === "awaiting-first-event" ? "first" : "subsequent"
      state = { _tag: "streaming", lastActivityAt: clock.now() }
      armTimer()
      if (onActivity) Effect.runFork(onActivity({ kind }))
      return {
        state,
        activity: true,
        deadline: currentDeadline ? Deferred.await(currentDeadline) : undefined,
      }
    }
    if (effect === "terminal") {
      cancelFiber()
      currentDeadline = undefined
      state = { _tag: "closed" }
      return { state, activity: false, deadline: undefined }
    }
    return { state, activity: false, deadline: undefined }
  }

  const cancel = () => {
    cancelFiber()
    currentDeadline = undefined
    if (state._tag !== "fired") state = { _tag: "closed" }
  }

  if (!disabled) armTimer()

  return {
    handle,
    state: () => state,
    cancel,
    _currentDeadline: () => currentDeadline,
  }
}

/**
 * Live Effect-backed clock. The Stream wrapper awaits `clock.sleep(ms)` so
 * deadlines advance with the live fiber; tests use a custom clock that
 * resolves the sleep Effect through a `Deferred` they control.
 */
export function liveWatchdogClock(): WatchdogClock {
  return {
    now: () => Effect.runSync(Effect.map(Clock.currentTimeMillis, (ms) => ms)),
    sleep: (ms) => Effect.sleep(`${Math.max(0, ms)} millis`),
  }
}

/**
 * Construct a `ProviderRequestTimeoutError`. Used by the live Stream wrapper
 * (inside `onTimeout`) and by tests to assert the typed-error shape.
 */
export const makeTimeoutError = (input: {
  readonly phase: TimeoutPhase
  readonly timeoutMs: number
  readonly providerID: string
  readonly modelID: string
}) => {
  const parsed = Number.parseInt(`${input.timeoutMs}`, 10)
  const safe = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  // Validate through the same NonNegativeInt codec used by the schema field
  // so the constructor never receives an out-of-range value.
  const validated = Schema.decodeSync(NonNegativeInt)(safe)
  return new ProviderRequestTimeoutError({
    message: timeoutMessage(input.phase, validated, input.providerID, input.modelID),
    phase: input.phase,
    timeoutMs: validated,
    providerID: input.providerID,
    modelID: input.modelID,
  })
}

const timeoutMessage = (phase: TimeoutPhase, ms: number, providerID: string, modelID: string) =>
  phase === "first_event"
    ? `Provider ${providerID}/${modelID} did not emit any event within ${ms}ms`
    : `Provider ${providerID}/${modelID} stream was idle for more than ${ms}ms`

const isStreamDoneCause = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some((reason) => Cause.isFailReason(reason) && Cause.isDone(reason.error))

/**
 * Wrap a `Stream.Stream<LLMEvent, E>` with the watchdog. The wrapper:
 *
 *   - emits every upstream event unchanged,
 *   - fails the stream with `ProviderRequestTimeoutError` exactly once when
 *     the deadline fires — independently of whether the upstream reacts to
 *     `abort.abort()` or ignores it,
 *   - cleans up the timer fiber, the request-scoped `AbortController`, and
 *     the consumer queue on every terminal transition (success, typed
 *     timeout, upstream failure, user cancel, scope end),
 *   - parks while a local `tool-call` is in flight and resumes on the next
 *     `step-start`.
 *
 * The wrapper is a no-op when `timeoutMs <= 0`.
 *
 * Implementation: the wrapper is `Stream.callback(...)` over the
 * consumer-facing queue. A producer fiber pulls events from upstream, feeds
 * them into the watchdog, and offers them to that queue. When the watchdog
 * fires, `onTimeout` fails the same queue with
 * `Cause.fail(ProviderRequestTimeoutError)` before calling `abort.abort()`.
 * This keeps the timeout in the stream failure channel instead of wrapping it
 * as an unfold/queue defect, and it does not depend on upstream honoring the
 * abort signal.
 */
export const withProviderRequestWatchdog = <E>(
  source: Stream.Stream<LLMEvent, E>,
  options: {
    readonly providerID: string
    readonly modelID: string
    readonly timeoutMs: number
    readonly abort: AbortController
    readonly clock?: WatchdogClock
  },
): Stream.Stream<LLMEvent, E | TimeoutInstance> => {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return source as Stream.Stream<LLMEvent, E | TimeoutInstance>
  }
  const clock = options.clock ?? liveWatchdogClock()
  const makeError = (phase: TimeoutPhase) =>
    makeTimeoutError({
      phase,
      timeoutMs: options.timeoutMs,
      providerID: options.providerID,
      modelID: options.modelID,
    })

  return Stream.callback<LLMEvent, E | TimeoutInstance>((queue) =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<void, never>()
      let terminated: "clean" | "timeout" | "cancel" | "upstream" | undefined
      let sawEvent = false

      const markDone = () => {
        Deferred.doneUnsafe(done, Effect.void)
      }
      const endQueue = () => {
        if (terminated) return false
        terminated = "clean"
        Queue.endUnsafe(queue)
        markDone()
        return true
      }
      const failQueue = (cause: Cause.Cause<E | TimeoutInstance | Cause.Done<void>>) => {
        if (terminated) return false
        terminated = "upstream"
        Queue.failCauseUnsafe(queue, cause)
        markDone()
        return true
      }
      const failTimeout = (phase: TimeoutPhase) => {
        if (terminated) return false
        terminated = "timeout"
        Queue.failCauseUnsafe(queue, Cause.fail(makeError(phase)))
        markDone()
        options.abort.abort()
        return true
      }

      const watchdog = createProviderRequestWatchdog({
        timeoutMs: options.timeoutMs,
        clock,
        onTimeout: (event) => Effect.sync(() => failTimeout(event.phase)),
      })

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          watchdog.cancel()
          if (terminated) return
          terminated = "cancel"
          markDone()
          options.abort.abort()
        }),
      )

      yield* Effect.gen(function* () {
        const pull = yield* Stream.toPull(source)
        while (true) {
          const chunk = yield* Effect.raceFirst(pull, Deferred.await(done))
          if (!chunk) return
          for (const event of chunk) {
            if (terminated) return
            sawEvent = true
            watchdog.handle(event)
            Queue.offerUnsafe(queue, event)
            if (event.type === "finish" || event.type === "provider-error") {
              watchdog.cancel()
              endQueue()
              return
            }
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            if (terminated) return
            if (isStreamDoneCause(cause)) {
              if (!sawEvent) failTimeout("first_event")
              else endQueue()
              watchdog.cancel()
              return
            }
            watchdog.cancel()
            failQueue(cause)
          }),
        ),
      )
    }),
  )
}

export { Exit }

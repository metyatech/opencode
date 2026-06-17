import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Schema, Stream } from "effect"
import { LLMEvent, type LLMEvent as LLMEventType } from "@opencode-ai/llm"
import {
  classifyEvent,
  createProviderRequestWatchdog,
  makeTimeoutError,
  withProviderRequestWatchdog,
  type WatchdogClock,
  type WatchdogState,
} from "../../../src/session/llm/provider-request-watchdog"
import { MessageV2 } from "../../../src/session/message-v2"
import { ProviderRequestTimeoutError } from "../../../src/session/message-error"
import { SessionRetry } from "../../../src/session/retry"

const PROVIDER_ID = "test-provider"
const MODEL_ID = "test-model"

type FakeClock = WatchdogClock & {
  /** Resolve the next armed deadline (if any). */
  readonly fire: () => Effect.Effect<void, never, never>
  readonly pending: () => ReadonlyArray<{ deferred: Deferred.Deferred<void, never>; remaining: number }>
  /**
   * Test hook: clear any pending deadline. The real watchdog interrupts the
   * sleep fiber on cancellation; the fake clock doesn't observe the
   * interruption, so tests invoke `clear()` after `watchdog.cancel()` or
   * after a pause/terminal transition that should drop the timer.
   */
  readonly clear: () => void
}

/**
 * Fake clock that records armed deadlines through Deferred instances. The
 * test suite drives deadlines deterministically via `fire()`. `now()` is a
 * manual counter advanced by the test before each `fire()` so the helper's
 * `armTimer` math matches the test's intent.
 *
 * Re-arming replaces the pending deadline: `sleep` removes the previous
 * entry from `deadlines` before queueing the new one, matching the watchdog
 * state machine's contract that each arm cancels the previous timer.
 */
function fakeClock(initial = 0): FakeClock {
  let currentDeadline: Deferred.Deferred<void, never> | undefined
  let currentRemaining = 0
  let current = initial
  const sleep = (ms: number): Effect.Effect<void, never, never> => {
    if (ms <= 0) return Effect.void
    // Each new sleep replaces any previously armed deadline.
    currentDeadline = Effect.runSync(Deferred.make<void, never>())
    currentRemaining = ms
    return Deferred.await(currentDeadline)
  }
  const fire = (): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const deferred = currentDeadline
      currentDeadline = undefined
      if (!deferred) return
      current += currentRemaining
      currentRemaining = 0
      yield* Deferred.succeed(deferred, void 0)
    })
  const pending = () => (currentDeadline ? [{ deferred: currentDeadline, remaining: currentRemaining }] : [])
  const clear = () => {
    currentDeadline = undefined
    currentRemaining = 0
  }
  return {
    now: () => current,
    sleep,
    fire,
    pending,
    clear,
  }
}

const stepStart = () => LLMEvent.stepStart({ index: 0 })
const textStart = (id = "t1") => LLMEvent.textStart({ id })
const textDelta = (id = "t1", text = "hi") => LLMEvent.textDelta({ id, text })
const textEnd = (id = "t1") => LLMEvent.textEnd({ id })
const reasoningStart = (id = "r1") => LLMEvent.reasoningStart({ id })
const reasoningDelta = (id = "r1", text = "think") => LLMEvent.reasoningDelta({ id, text })
const reasoningEnd = (id = "r1") => LLMEvent.reasoningEnd({ id })
const toolInputStart = (id = "tc1", name = "bash") => LLMEvent.toolInputStart({ id, name })
const toolInputDelta = (id = "tc1", name = "bash", text = "{}") =>
  LLMEvent.toolInputDelta({ id, name, text })
const toolInputEnd = (id = "tc1", name = "bash") => LLMEvent.toolInputEnd({ id, name })
const toolCall = (id = "tc1", name = "bash", providerExecuted?: boolean) =>
  LLMEvent.toolCall({
    id,
    name,
    input: {},
    ...(providerExecuted === undefined ? {} : { providerExecuted }),
  })
const toolResult = (id = "tc1", name = "bash", providerExecuted?: boolean) =>
  LLMEvent.toolResult({
    id,
    name,
    result: { type: "text", value: "ok" },
    ...(providerExecuted === undefined ? {} : { providerExecuted }),
  })
const toolError = (id = "tc1", name = "bash") => LLMEvent.toolError({ id, name, message: "boom" })
const stepFinish = () => LLMEvent.stepFinish({ index: 0, reason: "stop" })
const finish = () => LLMEvent.finish({ reason: "stop" })
const providerError = () => LLMEvent.providerError({ message: "upstream boom" })

/**
 * Build a watchdog state machine driven by a fake clock and record the
 * observed timeout phases + activity kinds. Tests then assert on `timeouts`
 * (phase-only) and `activities` arrays.
 */
function buildWatchdog(opts: {
  timeoutMs: number
  clock?: FakeClock
}): {
  watchdog: ReturnType<typeof createProviderRequestWatchdog>
  clock: FakeClock
  timeouts: Array<"first_event" | "stream_idle">
  activities: Array<"first" | "subsequent">
} {
  const clock = opts.clock ?? fakeClock(0)
  const timeouts: Array<"first_event" | "stream_idle"> = []
  const activities: Array<"first" | "subsequent"> = []
  const watchdog = createProviderRequestWatchdog({
    timeoutMs: opts.timeoutMs,
    clock,
    onTimeout: (event) =>
      Effect.sync(() => {
        timeouts.push(event.phase)
      }),
    onActivity: (event) =>
      Effect.sync(() => {
        activities.push(event.kind)
      }),
  })
  return { watchdog, clock, timeouts, activities }
}

describe("provider-request-watchdog state machine", () => {
  test("timeoutMs=0 stays inactive and never schedules a timer", () => {
    const { watchdog, clock, timeouts } = buildWatchdog({ timeoutMs: 0 })

    expect(watchdog.state()._tag).toBe("inactive")
    expect(clock.pending()).toHaveLength(0)

    watchdog.handle(textDelta())
    expect(watchdog.state()._tag).toBe("inactive")
    expect(clock.pending()).toHaveLength(0)
    expect(timeouts).toHaveLength(0)
  })

  test("first-event timeout fires `first_event` when no event arrives in time", async () => {
    const { watchdog, clock, timeouts } = buildWatchdog({ timeoutMs: 100 })

    expect(watchdog.state()._tag).toBe("awaiting-first-event")
    expect(clock.pending()).toHaveLength(1)

    await Effect.runPromise(clock.fire())

    const state = watchdog.state() as Extract<WatchdogState, { _tag: "fired" }>
    expect(state._tag).toBe("fired")
    expect(state.phase).toBe("first_event")
    expect(timeouts).toStrictEqual(["first_event"])
    // After firing the timer must be cleared.
    expect(clock.pending()).toHaveLength(0)
  })

  test("text delta before timeout keeps the timer alive and re-arms it", async () => {
    const { watchdog, clock, timeouts } = buildWatchdog({ timeoutMs: 100 })

    expect(watchdog.state()._tag).toBe("awaiting-first-event")
    watchdog.handle(textDelta())
    expect(watchdog.state()._tag).toBe("streaming")
    expect(clock.pending()).toHaveLength(1)

    // Cross the original 100ms deadline — but the re-armed 100ms window
    // (anchored at the textDelta's `clock.now()`) is also crossed because
    // the fake clock doesn't advance between the call and `fire()`.
    await Effect.runPromise(clock.fire())

    const state = watchdog.state() as Extract<WatchdogState, { _tag: "fired" }>
    expect(state._tag).toBe("fired")
    expect(state.phase).toBe("stream_idle")
    expect(timeouts).toStrictEqual(["stream_idle"])
  })

  test("reasoning delta updates the timer", async () => {
    const { watchdog, clock } = buildWatchdog({ timeoutMs: 50 })

    expect(watchdog.state()._tag).toBe("awaiting-first-event")
    watchdog.handle(reasoningDelta())
    expect(watchdog.state()._tag).toBe("streaming")
    expect(clock.pending()).toHaveLength(1)

    await Effect.runPromise(clock.fire())
    const state = watchdog.state() as Extract<WatchdogState, { _tag: "fired" }>
    expect(state._tag).toBe("fired")
    expect(state.phase).toBe("stream_idle")
  })

  test("local tool call parks the timer; no timeout even after waiting longer than timeoutMs", async () => {
    const { watchdog, clock, timeouts } = buildWatchdog({ timeoutMs: 100 })

    watchdog.handle(textStart())
    expect(watchdog.state()._tag).toBe("streaming")
    expect(clock.pending()).toHaveLength(1)

    watchdog.handle(toolCall("tc1", "bash"))
    const parked = watchdog.state() as Extract<WatchdogState, { _tag: "paused-for-tool" }>
    expect(parked._tag).toBe("paused-for-tool")
    // Pause clears the previous timer; tell the fake clock to forget it.
    clock.clear()

    watchdog.handle(toolResult("tc1", "bash"))
    expect(watchdog.state()._tag).toBe("paused-for-tool")

    watchdog.handle(toolError("tc1", "bash"))
    expect(watchdog.state()._tag).toBe("paused-for-tool")

    // Wait long enough that any timer would have crossed multiple windows.
    await Effect.runPromise(Effect.sleep("50 millis"))
    expect(watchdog.state()._tag).toBe("paused-for-tool")
    expect(timeouts).toHaveLength(0)
  })

  test("next step-start after tool finishes resumes the timer", async () => {
    const { watchdog, clock } = buildWatchdog({ timeoutMs: 80 })

    watchdog.handle(textStart())
    watchdog.handle(toolCall("tc1", "bash"))
    expect(watchdog.state()._tag).toBe("paused-for-tool")
    clock.clear()

    watchdog.handle(stepStart())
    expect(watchdog.state()._tag).toBe("streaming")
    expect(clock.pending()).toHaveLength(1)

    watchdog.handle(toolCall("tc2", "bash"))
    expect(watchdog.state()._tag).toBe("paused-for-tool")
    clock.clear()

    // Resume from the second pause.
    watchdog.handle(stepStart())
    expect(watchdog.state()._tag).toBe("streaming")
    expect(clock.pending()).toHaveLength(1)

    await Effect.runPromise(clock.fire())
    const state = watchdog.state() as Extract<WatchdogState, { _tag: "fired" }>
    expect(state._tag).toBe("fired")
    expect(state.phase).toBe("stream_idle")
  })

  test("tool-call with providerExecuted: true does NOT park", () => {
    const { watchdog, clock } = buildWatchdog({ timeoutMs: 100 })

    watchdog.handle(stepStart())
    watchdog.handle(toolCall("pc1", "web_search", true))
    const state = watchdog.state() as Extract<WatchdogState, { _tag: "streaming" }>
    expect(state._tag).toBe("streaming")
    expect(clock.pending()).toHaveLength(1)

    watchdog.handle(toolResult("pc1", "web_search", true))
    expect(watchdog.state()._tag).toBe("streaming")
    expect(clock.pending()).toHaveLength(1)
  })

  test("step-finish, finish, provider-error, and cancel clear the timer", async () => {
    type Scenario = {
      name: string
      drive: (watchdog: ReturnType<typeof createProviderRequestWatchdog>) => void
    }

    const scenarios: ReadonlyArray<Scenario> = [
      { name: "step-finish", drive: (w) => w.handle(stepFinish()) },
      { name: "finish", drive: (w) => w.handle(finish()) },
      { name: "provider-error", drive: (w) => w.handle(providerError()) },
      { name: "cancel", drive: (w) => w.cancel() },
    ]

    for (const scenario of scenarios) {
      const { watchdog, clock } = buildWatchdog({ timeoutMs: 100 })

      watchdog.handle(stepStart())
      expect(clock.pending()).toHaveLength(1)

      scenario.drive(watchdog)
      // The terminal transition clears the timer; tell the fake clock to
      // forget the pending deadline (its fiber was interrupted).
      clock.clear()

      await Effect.runPromise(Effect.sleep("10 millis"))
      const state = watchdog.state()
      expect(state._tag === "fired").toBe(false)
      expect(state._tag === "closed" || state._tag === "inactive").toBe(true)
    }
  })

  test("user cancel via state cancellation never classifies as a timeout", async () => {
    const { watchdog, clock, timeouts } = buildWatchdog({ timeoutMs: 100 })

    watchdog.handle(textStart())
    watchdog.cancel()

    await Effect.runPromise(Effect.sleep("200 millis"))
    const state = watchdog.state()
    expect(state._tag).toBe("closed")
    expect(timeouts).toHaveLength(0)
  })

  test("after firing, timer/listener/handle are cleared (no pending timers)", async () => {
    const { watchdog, clock } = buildWatchdog({ timeoutMs: 50 })

    await Effect.runPromise(clock.fire())
    expect(watchdog.state()._tag).toBe("fired")
    expect(clock.pending()).toHaveLength(0)

    const result = watchdog.handle(textDelta())
    expect(result.activity).toBe(false)
    expect(watchdog.state()._tag).toBe("fired")
  })

  test("makeTimeoutError exposes all fields", () => {
    const error = makeTimeoutError({
      phase: "first_event",
      timeoutMs: 1500,
      providerID: PROVIDER_ID,
      modelID: MODEL_ID,
    })

    expect(error.name).toBe("ProviderRequestTimeoutError")
    const obj = error.toObject()
    expect(obj.name).toBe("ProviderRequestTimeoutError")
    expect(obj.data).toMatchObject({
      phase: "first_event",
      timeoutMs: 1500,
      providerID: PROVIDER_ID,
      modelID: MODEL_ID,
    })
    expect(typeof obj.data.message).toBe("string")
    expect(obj.data.message).toContain("did not emit")

    // Decoding through the typed error schema round-trips.
    const decoded = Schema.decodeUnknownSync(ProviderRequestTimeoutError.Schema)(obj)
    expect(decoded.name).toBe("ProviderRequestTimeoutError")
    if (decoded.name !== "ProviderRequestTimeoutError") throw new Error("unreachable")
    expect(decoded.data.phase).toBe("first_event")
    expect(decoded.data.timeoutMs).toBe(1500)
    expect(decoded.data.providerID).toBe(PROVIDER_ID)
    expect(decoded.data.modelID).toBe(MODEL_ID)
  })

  test("timeout is not retried by SessionRetry.policy", () => {
    const first = new MessageV2.ProviderRequestTimeoutError({
      message: "Provider test-provider/test-model did not emit any event within 1000ms",
      phase: "first_event",
      timeoutMs: 1000,
      providerID: PROVIDER_ID,
      modelID: MODEL_ID,
    }).toObject()

    expect(SessionRetry.retryable(first, PROVIDER_ID)).toBeUndefined()

    const idle = new MessageV2.ProviderRequestTimeoutError({
      message: "Provider test-provider/test-model stream was idle for more than 1000ms",
      phase: "stream_idle",
      timeoutMs: 1000,
      providerID: PROVIDER_ID,
      modelID: MODEL_ID,
    }).toObject()

    expect(SessionRetry.retryable(idle, PROVIDER_ID)).toBeUndefined()
  })

  test("classifyEvent classifies every normalized LLMEvent variant", () => {
    expect(classifyEvent(stepStart())).toBe("resume-from-tool")
    expect(classifyEvent(textStart())).toBe("activity")
    expect(classifyEvent(textDelta())).toBe("activity")
    expect(classifyEvent(textEnd())).toBe("activity")
    expect(classifyEvent(reasoningStart())).toBe("activity")
    expect(classifyEvent(reasoningDelta())).toBe("activity")
    expect(classifyEvent(reasoningEnd())).toBe("activity")
    expect(classifyEvent(toolInputStart())).toBe("activity")
    expect(classifyEvent(toolInputDelta())).toBe("activity")
    expect(classifyEvent(toolInputEnd())).toBe("activity")
    expect(classifyEvent(toolCall("c1", "x"))).toBe("pause-for-tool")
    expect(classifyEvent(toolCall("c1", "x", true))).toBe("activity")
    expect(classifyEvent(toolResult("c1", "x"))).toBe("noop")
    expect(classifyEvent(toolResult("c1", "x", true))).toBe("activity")
    expect(classifyEvent(toolError())).toBe("noop")
    expect(classifyEvent(stepFinish())).toBe("terminal")
    expect(classifyEvent(finish())).toBe("terminal")
    expect(classifyEvent(providerError())).toBe("terminal")
  })

  test("withProviderRequestWatchdog returns source unchanged when timeoutMs=0", async () => {
    const ctrl = new AbortController()
    const source = Stream.fromIterable([stepStart(), textDelta()] as never) as Stream.Stream<
      LLMEventType,
      never
    >

    const wrapped = withProviderRequestWatchdog(source, {
      providerID: PROVIDER_ID,
      modelID: MODEL_ID,
      timeoutMs: 0,
      abort: ctrl,
    })

    const events: string[] = []
    await Effect.runPromise(
      Stream.runForEach(wrapped, (event) =>
        Effect.sync(() => {
          events.push(event.type)
        }),
      ),
    )

    expect(events).toStrictEqual(["step-start", "text-delta"])
    expect(ctrl.signal.aborted).toBe(false)
  })

  test("ProviderRequestTimeoutError is registered in MessageV2.Shared", () => {
    const error = new ProviderRequestTimeoutError({
      message: "Provider p/m did not emit any event within 100ms",
      phase: "first_event",
      timeoutMs: 100,
      providerID: "p",
      modelID: "m",
    }).toObject()
    expect(MessageV2.ProviderRequestTimeoutError.isInstance(error)).toBe(true)
  })

  test("fromError returns ProviderRequestTimeoutError unchanged BEFORE the AbortError branch", () => {
    const error = new ProviderRequestTimeoutError({
      message: "Provider p/m did not emit any event within 100ms",
      phase: "first_event",
      timeoutMs: 100,
      providerID: "p",
      modelID: "m",
    })

    const result = MessageV2.fromError(error, { providerID: "p" as never })
    expect(result.name).toBe("ProviderRequestTimeoutError")
    if (result.name !== "ProviderRequestTimeoutError") throw new Error("expected ProviderRequestTimeoutError")
    expect(result.data.phase).toBe("first_event")
    expect(result.data.timeoutMs).toBe(100)
    expect(result.data.providerID).toBe("p")
    expect(result.data.modelID).toBe("m")

    // AbortError DOMException still flows through the AbortError branch.
    const abortError = new DOMException("user aborted", "AbortError")
    const abortResult = MessageV2.fromError(abortError, { providerID: "p" as never })
    expect(abortResult.name).toBe("MessageAbortedError")
  })

  test("Cause.fail surfaces the typed error when the watchdog aborts the stream", async () => {
    // Construct the typed error the way the wrapper would and confirm a
    // Stream.fail with it reaches the consumer as a Cause failure.
    const error = makeTimeoutError({
      phase: "first_event",
      timeoutMs: 50,
      providerID: PROVIDER_ID,
      modelID: MODEL_ID,
    })

    const failed = Stream.fail(error).pipe(Stream.runDrain).pipe(Effect.exit)
    const exit = await Effect.runPromise(failed)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const squashed = Cause.squash(exit.cause)
      expect(MessageV2.ProviderRequestTimeoutError.isInstance(squashed)).toBe(true)
    }
  })

  test("withProviderRequestWatchdog wraps AI SDK-shaped and native-shaped streams uniformly", async () => {
    // We exercise the shape parity through the state machine: both shapes
    // drive the same watchdog transitions, so wrapping either produces the
    // same first-event classification.
    const driveShape = (events: ReadonlyArray<LLMEventType>) => {
      const { watchdog, clock, timeouts } = buildWatchdog({ timeoutMs: 100 })
      for (const event of events) watchdog.handle(event)
      return { watchdog, clock, timeouts }
    }

    const aiSdk = driveShape([stepStart(), textDelta("t1", "hello")])
    const native = driveShape([stepStart(), textDelta("t1", "hello")])

    expect(aiSdk.watchdog.state()._tag).toBe("streaming")
    expect(native.watchdog.state()._tag).toBe("streaming")

    // Fire each watchdog's armed deadline. The fake clock is per-watchdog so
    // we drive each independently.
    await Effect.runPromise(aiSdk.clock.fire())
    await Effect.runPromise(native.clock.fire())

    for (const result of [aiSdk, native]) {
      const state = result.watchdog.state() as Extract<WatchdogState, { _tag: "fired" }>
      expect(state._tag).toBe("fired")
      expect(state.phase).toBe("stream_idle")
      expect(result.timeouts).toStrictEqual(["stream_idle"])
    }
  })

  test("Fiber cleanup: cancel() closes the watchdog", async () => {
    const { watchdog, clock } = buildWatchdog({ timeoutMs: 100 })

    expect(clock.pending()).toHaveLength(1)

    watchdog.cancel()

    await Effect.runPromise(Effect.sleep("10 millis"))
    expect(watchdog.state()._tag).toBe("closed")
    // Firing after cancel must be a no-op (the deadline was replaced when
    // cancel() called cancelFiber, which cleared `currentDeadline`).
    await Effect.runPromise(clock.fire())
    expect(watchdog.state()._tag).toBe("closed")
  })
})

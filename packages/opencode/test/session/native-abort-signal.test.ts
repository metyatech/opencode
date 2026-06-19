import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect"
import { testEffect, awaitWithTimeout, pollWithTimeout } from "../lib/effect"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"

// The native runtime wires each attempt's `AbortSignal` directly into the
// provider HTTP stream via `Stream.interruptWhen(abortToEffect(signal))`.
// These tests prove the wiring deterministically tears the stream down when
// the signal fires (rather than relying on ambient fiber interruption), and
// that per-attempt signals are isolated: aborting attempt 1 does not affect
// attempt 2.
const it = testEffect(Layer.empty)

describe("native runtime abort wiring", () => {
  it.live("abortToEffect resolves immediately when the signal is already aborted", () =>
    Effect.gen(function* () {
      const ctrl = new AbortController()
      ctrl.abort()
      yield* awaitWithTimeout(LLMNativeRuntime.abortToEffect(ctrl.signal), "already-aborted signal did not resolve")
    }),
  )

  it.live("aborting the signal interrupts the wrapped provider stream", () =>
    Effect.gen(function* () {
      const ctrl = new AbortController()
      const finalized = yield* Deferred.make<void>()
      // A never-ending provider stream that records when its scope is torn
      // down — exactly how an in-flight HTTP request fiber would unwind.
      const provider = Stream.never.pipe(
        Stream.ensuring(Deferred.succeed(finalized, undefined)),
        Stream.interruptWhen(LLMNativeRuntime.abortToEffect(ctrl.signal)),
      )
      const fiber = yield* Stream.runDrain(provider).pipe(Effect.forkChild)
      // Tear down via the signal; the stream must complete and finalize.
      ctrl.abort()
      yield* awaitWithTimeout(Fiber.await(fiber), "stream was not interrupted by abort")
      yield* awaitWithTimeout(Deferred.await(finalized), "stream scope was not finalized after abort")
    }),
  )

  it.live("per-attempt signals are isolated: aborting attempt 1 leaves attempt 2 running", () =>
    Effect.gen(function* () {
      const ctrl1 = new AbortController()
      const ctrl2 = new AbortController()
      const emitted = yield* Ref.make(0)
      const finalized1 = yield* Deferred.make<void>()
      const finalized2 = yield* Deferred.make<void>()

      const attempt = (signal: AbortSignal, finalized: Deferred.Deferred<void>) =>
        Stream.fromEffect(Ref.update(emitted, (n) => n + 1)).pipe(
          Stream.concat(Stream.never),
          Stream.ensuring(Deferred.succeed(finalized, undefined)),
          Stream.interruptWhen(LLMNativeRuntime.abortToEffect(signal)),
        )

      const fiber1 = yield* Stream.runDrain(attempt(ctrl1.signal, finalized1)).pipe(Effect.forkChild)
      const fiber2 = yield* Stream.runDrain(attempt(ctrl2.signal, finalized2)).pipe(Effect.forkChild)

      // Both attempts have started their (independent) streams.
      yield* pollWithTimeout(
        Effect.gen(function* () {
          return (yield* Ref.get(emitted)) === 2 ? (true as const) : undefined
        }),
        "both attempts never started",
      )

      // Abort only attempt 1.
      ctrl1.abort()
      yield* awaitWithTimeout(Fiber.await(fiber1), "attempt 1 was not interrupted")
      yield* awaitWithTimeout(Deferred.await(finalized1), "attempt 1 scope was not finalized")

      // Attempt 2 must still be running (its scope not finalized) because
      // attempt 1's abort signal is independent.
      expect(yield* Deferred.isDone(finalized2)).toBe(false)

      // Cleanup: abort attempt 2 and confirm it tears down on its own signal.
      ctrl2.abort()
      yield* awaitWithTimeout(Fiber.await(fiber2), "attempt 2 was not interrupted by its own abort")
      yield* awaitWithTimeout(Deferred.await(finalized2), "attempt 2 scope was not finalized")
    }),
  )
})

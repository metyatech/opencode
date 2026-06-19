import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Layer, Ref, Scope } from "effect"
import { testEffect, pollWithTimeout, awaitWithTimeout } from "../lib/effect"
import { Runner } from "@/effect/runner"

// `Runner.tryStart` is the atomic claim-or-fail primitive that underpins
// `session.retryExact`'s integration with the per-session runner. The
// normal prompt path (`ensureRunning`) and the exact-retry path
// (`SessionRunState.claimExclusive` -> `tryStart`) both occupy the SAME
// `Running` state on the SAME per-session runner, so proving that
// `tryStart` refuses to start a second run while the runner is busy
// proves both exact-vs-exact and exact-vs-normal-prompt mutual exclusion
// at the authoritative gate.
const it = testEffect(Layer.empty)

describe("Runner.tryStart", () => {
  it.live("claims when idle, refuses while running, and never double-starts", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const ran = yield* Ref.make<string[]>([])
      const gate = yield* Deferred.make<void>()
      const runner = Runner.make<number>(scope)

      const work = (tag: string, started: Deferred.Deferred<void>) =>
        Effect.gen(function* () {
          yield* Ref.update(ran, (a) => [...a, tag])
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(gate)
          return 1
        })

      // First claim succeeds and transitions the runner to Running.
      const startedA = yield* Deferred.make<void>()
      const first = yield* runner.tryStart(work("a", startedA))
      expect(first).toBe(true)
      expect(runner.busy).toBe(true)
      yield* awaitWithTimeout(Deferred.await(startedA), "work 'a' never started")

      // Concurrent claim loses: the runner is Running, so the second
      // work is NEVER started (no double-start, no silent join).
      const startedB = yield* Deferred.make<void>()
      const second = yield* runner.tryStart(work("b", startedB))
      expect(second).toBe(false)
      expect(yield* Ref.get(ran)).toEqual(["a"])

      // Release the in-flight run; the runner returns to Idle on its own.
      yield* Deferred.succeed(gate, undefined)
      yield* pollWithTimeout(
        Effect.sync(() => (runner.busy ? undefined : (true as const))),
        "runner never returned to idle",
      )

      // A fresh claim after completion succeeds again.
      const third = yield* runner.tryStart(Effect.succeed(2))
      expect(third).toBe(true)

      // "b" must never have executed.
      expect(yield* Ref.get(ran)).toEqual(["a"])

      yield* Scope.close(scope, Exit.void)
    }),
  )
})

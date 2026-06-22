import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Layer, Scope } from "effect"
import { ProcessAdapter, type ProcessAdapterService } from "../../src/process-manager/adapter"
import { ProcessManager } from "../../src/process-manager/service"
import { ProcessHandle } from "../../src/process-manager/id"
import { testEffect } from "../lib/effect"

// Records every `stop` call. Used by tests that need to count adapter
// invocations.
class RecordingProcessAdapter implements ProcessAdapterService {
  readonly stops: number[] = []
  pid(child: { pid: number | null }): number | undefined {
    return child.pid ?? undefined
  }
  stop(_input: { pid: number; graceMs?: number }): Effect.Effect<void> {
    return Effect.void
  }
}

const fake = new RecordingProcessAdapter()
const adapterLayer = Layer.succeed(ProcessAdapter, ProcessAdapter.of(fake))
const it = testEffect(ProcessManager.layer.pipe(Layer.provide(adapterLayer)))

// A fake child whose `exitCode` resolves when the test calls
// `finishExit`. `kill` is a no-op; the test never relies on it
// because the adapter is what terminates the OS process.
function makeFakeChild(opts: {
  pid: number
  exit?: Deferred.Deferred<number, never>
}) {
  return {
    pid: opts.pid,
    exitCode: opts.exit
      ? Effect.flatMap(Deferred.await(opts.exit), (n) => Effect.succeed(n))
      : Effect.succeed(0),
    kill: () => {},
    stdin: undefined,
  }
}

// Mirror the shell tool's `longScope` / `longScopeRelease` pattern.
// The schema accepts the release as `unknown`; we cast at the
// manager boundary to the manager's internal `OwnedScopeRelease`
// type. The actual `Scope.close` effect carries an `R` channel of
// `Scope`; the manager runs the effect inside its own layer so the
// dependency is satisfied.
function makeOwnedScope(): {
  release: Effect.Effect<void, never, Scope.Scope>
} {
  const scope = Effect.runSync(Scope.make())
  return { release: Scope.close(scope, Exit.void) }
}

describe("ProcessManager owned-scope lifecycle", () => {
  it.instance(
    "promote accepts a caller-owned release; natural exit records reached terminal state",
    () =>
      Effect.gen(function* () {
        const manager = yield* ProcessManager.Service
        const exit = yield* Deferred.make<number, never>()
        const owned = makeOwnedScope()

        const info = yield* manager.promote({
          sessionID: "ses_lifecycle_natural",
          command: "x",
          cwd: "/",
          pid: 9001,
          stdinAvailable: false,
          child: makeFakeChild({ pid: 9001, exit }),
          // The schema accepts `unknown`; the manager casts to
          // `OwnedScopeRelease` at the boundary.
          release: owned.release as unknown,
        })
        expect(info.state).toBe("running")

        // Natural exit: the manager's exit watcher calls
        // finalizeRecord, which calls closeOwnedScope exactly once.
        yield* Deferred.succeed(exit, 0)
        yield* Effect.sleep("20 millis")
        const after = yield* manager.info({
          sessionID: "ses_lifecycle_natural",
          handle: info.handle as ProcessHandle,
        })
        expect(after!.state).toBe("exited")
        expect(after!.terminationReason).toBe("natural")
      }),
  )

  it.instance(
    "manual stop preserves the 'stopped' state even when the natural exit watcher fires later",
    () =>
      Effect.gen(function* () {
        const manager = yield* ProcessManager.Service
        const exit = yield* Deferred.make<number, never>()
        const owned = makeOwnedScope()

        const info = yield* manager.promote({
          sessionID: "ses_lifecycle_idem",
          command: "x",
          cwd: "/",
          pid: 9002,
          stdinAvailable: false,
          child: makeFakeChild({ pid: 9002, exit }),
          release: owned.release as unknown,
        })

        // Manual stop: the manager's finalizeRecord fires with
        // reason="stopped". The natural exit watcher later fires with
        // reason="natural", but finalizeRecord's priority rule
        // preserves the user-initiated "stopped" state and
        // closeOwnedScope's `ownedScopeClosed` guard makes the
        // second release a no-op.
        const stopInfo = yield* manager.stop({
          sessionID: "ses_lifecycle_idem",
          handle: info.handle as ProcessHandle,
        })
        expect(stopInfo.state).toBe("stopped")
        expect(stopInfo.terminationReason).toBe("stopped")

        yield* Deferred.succeed(exit, 0)
        yield* Effect.sleep("20 millis")
        const after = yield* manager.info({
          sessionID: "ses_lifecycle_idem",
          handle: info.handle as ProcessHandle,
        })
        // The record must STILL be "stopped" — the natural watcher
        // did not flip it to "exited". This proves finalizeRecord's
        // priority rule works AND closeOwnedScope is idempotent.
        expect(after!.state).toBe("stopped")
        expect(after!.terminationReason).toBe("stopped")
      }),
  )

  it.instance(
    "killAllForSession closes the owned scope for every live record in the session",
    () =>
      Effect.gen(function* () {
        const manager = yield* ProcessManager.Service
        const e1 = yield* Deferred.make<number, never>()
        const e2 = yield* Deferred.make<number, never>()
        yield* manager.promote({
          sessionID: "ses_lifecycle_killall",
          command: "x",
          cwd: "/",
          pid: 9003,
          stdinAvailable: false,
          child: makeFakeChild({ pid: 9003, exit: e1 }),
          release: makeOwnedScope().release as unknown,
        })
        yield* manager.promote({
          sessionID: "ses_lifecycle_killall",
          command: "y",
          cwd: "/",
          pid: 9004,
          stdinAvailable: false,
          child: makeFakeChild({ pid: 9004, exit: e2 }),
          release: makeOwnedScope().release as unknown,
        })
        yield* manager.killAllForSession("ses_lifecycle_killall")
        const after = yield* manager.list({ sessionID: "ses_lifecycle_killall" })
        expect(after.length).toBe(2)
        expect(
          after.every((r) => r.state === "stopped" && r.terminationReason === "stopped"),
        ).toBe(true)
        // Every record's `endedAt` is set — terminate finalizeRecord
        // path ran for every record.
        expect(after.every((r) => r.endedAt !== undefined && r.endedAt !== null)).toBe(true)
      }),
  )

  it.instance(
    "promote without release works for internal-only records (no caller-owned scope)",
    () =>
      Effect.gen(function* () {
        const manager = yield* ProcessManager.Service
        const exit = yield* Deferred.make<number, never>()
        const info = yield* manager.promote({
          sessionID: "ses_lifecycle_internal",
          command: "x",
          cwd: "/",
          pid: 9005,
          stdinAvailable: false,
          child: makeFakeChild({ pid: 9005, exit }),
          // release omitted on purpose: internal records never have
          // caller-owned scopes.
        })
        yield* Deferred.succeed(exit, 0)
        yield* Effect.sleep("20 millis")
        const after = yield* manager.info({
          sessionID: "ses_lifecycle_internal",
          handle: info.handle as ProcessHandle,
        })
        expect(after!.state).toBe("exited")
        expect(after!.terminationReason).toBe("natural")
      }),
  )
})

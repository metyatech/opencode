import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { ProcessAdapter, type ProcessAdapterService } from "../../src/process-manager/adapter"
import { ProcessManager } from "../../src/process-manager/service"
import { testEffect } from "../lib/effect"

// FakeProcessAdapter is a no-op for the hard-deadline tests because we never
// actually need the OS to terminate anything — the manager owns the timeout
// trigger and reports state itself. Stops are recorded only so we can prove
// the manager called `adapter.stop({ pid, graceMs: 200 })` when the deadline
// fired.
class FakeProcessAdapter implements ProcessAdapterService {
  readonly stops: number[] = []
  pid(child: { pid: number | null }): number | undefined {
    return child.pid ?? undefined
  }
  stop(input: { pid: number; graceMs?: number }): Effect.Effect<void> {
    this.stops.push(input.pid)
    return Effect.void
  }
}

function makeFakeChild(opts: {
  pid: number
  exit: Deferred.Deferred<number, never>
}) {
  return {
    pid: opts.pid,
    exitCode: Effect.flatMap(Deferred.await(opts.exit), (n) => Effect.succeed(n)),
    kill: () => {},
    stdin: undefined,
  }
}

const fake = new FakeProcessAdapter()
const adapterLayer = Layer.succeed(ProcessAdapter, ProcessAdapter.of(fake))
const it = testEffect(ProcessManager.layer.pipe(Layer.provide(adapterLayer)))

describe("ProcessManager hard timeout", () => {
  it.instance("promote with timeoutMs ends the record as failed/timeout", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const child = makeFakeChild({ pid: 7001, exit })
      const info = yield* manager.promote({
        sessionID: "ses_ht",
        command: "long-running",
        cwd: "/",
        pid: 7001,
        stdinAvailable: false,
        child,
        timeoutMs: 300,
      })

      // Initially running, no termination reason yet.
      expect(info.state).toBe("running")
      expect(info.timeoutMs).toBe(300)

      // Wait past the timeoutMs.
      yield* Effect.sleep("400 millis")

      const fetched = yield* manager.info({ sessionID: "ses_ht", handle: info.handle })
      expect(fetched).toBeDefined()
      expect(fetched!.state).toBe("failed")
      expect(fetched!.terminationReason).toBe("timeout")
      expect(fetched!.signal).toBe("TIMEOUT")
      expect(fetched!.endedAt).toBeDefined()
      expect(fetched!.endedAt).not.toBeNull()
      // Adapter was asked to stop the child.
      expect(fake.stops).toContain(7001)
    }),
  )

  it.instance("promote without timeoutMs keeps the record running until the child exits", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const child = makeFakeChild({ pid: 7002, exit })
      const info = yield* manager.promote({
        sessionID: "ses_no_ht",
        command: "indefinite",
        cwd: "/",
        pid: 7002,
        stdinAvailable: false,
        child,
        timeoutMs: null,
      })

      expect(info.state).toBe("running")
      expect(info.timeoutMs).toBeNull()

      // Wait long enough that a 300ms deadline would have fired.
      yield* Effect.sleep("400 millis")

      const fetched = yield* manager.info({ sessionID: "ses_no_ht", handle: info.handle })
      expect(fetched).toBeDefined()
      expect(fetched!.state).toBe("running")
      expect(fetched!.endedAt).toBeUndefined()
      // No spurious stop call.
      expect(fake.stops).not.toContain(7002)
    }),
  )
})

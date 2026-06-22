import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { ProcessAdapter, type ProcessAdapterService } from "../../src/process-manager/adapter"
import { ProcessManager } from "../../src/process-manager/service"
import { testEffect } from "../lib/effect"

// FakeProcessAdapter captures stop calls so we can assert the manager only
// signalled the records it should have. Pid is a passthrough.
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

describe("ProcessManager cleanup state updates", () => {
  it.instance(
    "killAllForSession marks running/starting records stopped with endedAt set; other sessions untouched",
    () =>
      Effect.gen(function* () {
        const manager = yield* ProcessManager.Service
        const aExit = yield* Deferred.make<number, never>()
        const bExit = yield* Deferred.make<number, never>()
        const a = yield* manager.promote({
          sessionID: "sesA",
          command: "x",
          cwd: "/",
          pid: 8001,
          stdinAvailable: false,
          child: makeFakeChild({ pid: 8001, exit: aExit }),
        })
        const b = yield* manager.promote({
          sessionID: "sesB",
          command: "y",
          cwd: "/",
          pid: 8002,
          stdinAvailable: false,
          child: makeFakeChild({ pid: 8002, exit: bExit }),
        })

        yield* manager.killAllForSession("sesA")

        const aInfo = yield* manager.info({ sessionID: "sesA", handle: a.handle })
        const bInfo = yield* manager.info({ sessionID: "sesB", handle: b.handle })
        expect(aInfo).toBeDefined()
        expect(aInfo!.state).toBe("stopped")
        expect(aInfo!.endedAt).toBeDefined()
        expect(aInfo!.endedAt).not.toBeNull()
        expect(aInfo!.terminationReason).toBe("stopped")
        // sesB record untouched.
        expect(bInfo).toBeDefined()
        expect(bInfo!.state).toBe("running")
        expect(bInfo!.endedAt).toBeUndefined()
        // Adapter was only asked to stop sesA's pid, not sesB's.
        expect(fake.stops).toContain(8001)
        expect(fake.stops).not.toContain(8002)
      }),
  )

  it.instance("killAll marks every running/starting record stopped across sessions", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const aExit = yield* Deferred.make<number, never>()
      const bExit = yield* Deferred.make<number, never>()
      yield* manager.promote({
        sessionID: "sesK1",
        command: "x",
        cwd: "/",
        pid: 8101,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 8101, exit: aExit }),
      })
      yield* manager.promote({
        sessionID: "sesK2",
        command: "y",
        cwd: "/",
        pid: 8102,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 8102, exit: bExit }),
      })

      yield* manager.killAll()

      const aList = yield* manager.list({ sessionID: "sesK1" })
      const bList = yield* manager.list({ sessionID: "sesK2" })
      expect(aList.every((r) => r.state === "stopped" && r.endedAt !== undefined && r.endedAt !== null)).toBe(true)
      expect(bList.every((r) => r.state === "stopped" && r.endedAt !== undefined && r.endedAt !== null)).toBe(true)
      expect(fake.stops).toContain(8101)
      expect(fake.stops).toContain(8102)
    }),
  )

  it.instance("killAll is idempotent on already-stopped records", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const info = yield* manager.promote({
        sessionID: "sesIdem",
        command: "x",
        cwd: "/",
        pid: 8201,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 8201, exit }),
      })

      yield* manager.killAll()
      const firstInfo = yield* manager.info({ sessionID: "sesIdem", handle: info.handle })
      const firstEndedAt = firstInfo!.endedAt
      expect(firstInfo!.state).toBe("stopped")
      const stopsAfterFirst = fake.stops.length

      // Second call must not throw and must not re-stop.
      yield* manager.killAll()
      const secondInfo = yield* manager.info({ sessionID: "sesIdem", handle: info.handle })
      expect(secondInfo!.state).toBe("stopped")
      expect(secondInfo!.endedAt).toBe(firstEndedAt)
      expect(fake.stops.length).toBe(stopsAfterFirst)
    }),
  )
})

import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { ProcessAdapter, type ProcessAdapterService } from "../../src/process-manager/adapter"
import { ProcessManager } from "../../src/process-manager/service"
import { ProcessHandle } from "../../src/process-manager/id"
import { testEffect } from "../lib/effect"

// FakeProcessAdapter captures every `stop` call so tests can assert what was
// signalled. `pid` is a passthrough; no real OS involvement.
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

// Controllable child. `exit` resolves when the test calls `finishExit(code)`.
function makeFakeChild(opts: { pid: number; stdin?: boolean; exit?: Deferred.Deferred<number, never> }): {
  pid: number
  exitCode: Effect.Effect<number, never, never>
  kill: () => void
  stdin?: { write: (chunk: string) => Effect.Effect<void, never, never>; close: () => Effect.Effect<void, never, never> }
} {
  return {
    pid: opts.pid,
    exitCode: opts.exit
      ? Effect.flatMap(Deferred.await(opts.exit), (n) => Effect.succeed(n))
      : Effect.succeed(0),
    kill: () => {},
    stdin: opts.stdin
      ? {
          write: () => Effect.void,
          close: () => Effect.void,
        }
      : undefined,
  }
}

const fake = new FakeProcessAdapter()
const adapterLayer = Layer.succeed(ProcessAdapter, ProcessAdapter.of(fake))

const it = testEffect(ProcessManager.layer.pipe(Layer.provide(adapterLayer)))

describe("ProcessManager service", () => {
  it.instance("promote inserts a record visible via info", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const child = makeFakeChild({ pid: 1234, exit })

      const info = yield* manager.promote({
        sessionID: "ses_alpha",
        command: "sleep 10",
        cwd: "/tmp",
        pid: 1234,
        stdinAvailable: true,
        child,
      })
      expect(info.state).toBe("running")
      expect(info.command).toBe("sleep 10")
      expect(info.pid).toBe(1234)
      expect(info.ownerSessionID).toBe("ses_alpha")

      const fetched = yield* manager.info({ sessionID: "ses_alpha", handle: info.handle })
      expect(fetched).toBeDefined()
      expect(fetched?.handle).toBe(info.handle)
    }),
  )

  it.instance("list filters by sessionID", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const child = makeFakeChild({ pid: 1, exit })

      const a = yield* manager.promote({
        sessionID: "ses_a",
        command: "x",
        cwd: "/",
        pid: 1,
        stdinAvailable: true,
        child,
      })
      const b = yield* manager.promote({
        sessionID: "ses_b",
        command: "y",
        cwd: "/",
        pid: 2,
        stdinAvailable: true,
        child,
      })

      const allA = yield* manager.list({ sessionID: "ses_a" })
      const allB = yield* manager.list({ sessionID: "ses_b" })
      expect(allA.map((r) => r.handle)).toEqual([a.handle])
      expect(allB.map((r) => r.handle)).toEqual([b.handle])
    }),
  )

  it.instance("info returns undefined for cross-session AND missing", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const child = makeFakeChild({ pid: 99, exit })
      const info = yield* manager.promote({
        sessionID: "ses_owner",
        command: "x",
        cwd: "/",
        pid: 99,
        stdinAvailable: true,
        child,
      })

      const cross = yield* manager.info({ sessionID: "ses_other", handle: info.handle })
      expect(cross).toBeUndefined()

      const missing = yield* manager.info({
        sessionID: "ses_owner",
        handle: ProcessHandle.make("proc_does_not_exist"),
      })
      expect(missing).toBeUndefined()
    }),
  )

  it.instance("stop is idempotent on already-stopped processes", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const child = makeFakeChild({ pid: 7, exit })
      const info = yield* manager.promote({
        sessionID: "ses_idem",
        command: "x",
        cwd: "/",
        pid: 7,
        stdinAvailable: true,
        child,
      })

      const first = yield* manager.stop({ sessionID: "ses_idem", handle: info.handle })
      expect(first.state).toBe("stopped")
      const before = fake.stops.length

      const second = yield* manager.stop({ sessionID: "ses_idem", handle: info.handle })
      expect(second.state).toBe("stopped")
      // The second stop is a no-op -> adapter should not be called again
      expect(fake.stops.length).toBe(before)
    }),
  )

  it.instance("stop calls adapter.stop with the record's pid", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const child = makeFakeChild({ pid: 4242, exit })
      const info = yield* manager.promote({
        sessionID: "ses_stop",
        command: "x",
        cwd: "/",
        pid: 4242,
        stdinAvailable: true,
        child,
      })
      yield* manager.stop({ sessionID: "ses_stop", handle: info.handle })
      expect(fake.stops).toContain(4242)
    }),
  )

  it.instance("killAll only stops running records", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      // Two running + one already stopped
      const exit1 = yield* Deferred.make<number, never>()
      const exit2 = yield* Deferred.make<number, never>()
      const c1 = makeFakeChild({ pid: 11, exit: exit1 })
      const c2 = makeFakeChild({ pid: 22, exit: exit2 })
      const a = yield* manager.promote({
        sessionID: "ses_ka",
        command: "x",
        cwd: "/",
        pid: 11,
        stdinAvailable: true,
        child: c1,
      })
      yield* manager.promote({
        sessionID: "ses_ka",
        command: "x",
        cwd: "/",
        pid: 22,
        stdinAvailable: true,
        child: c2,
      })
      yield* manager.stop({ sessionID: "ses_ka", handle: a.handle })

      const before = fake.stops.length
      yield* manager.killAll()
      // Only the still-running pid=22 should be added.
      expect(fake.stops.length).toBe(before + 1)
      expect(fake.stops[fake.stops.length - 1]).toBe(22)
    }),
  )

  it.instance("write to a closed-stdin child fails with StdinClosed", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const child = makeFakeChild({ pid: 31, exit }) // stdin=undefined
      const info = yield* manager.promote({
        sessionID: "ses_w",
        command: "x",
        cwd: "/",
        pid: 31,
        stdinAvailable: false,
        child,
      })

      const exit2 = yield* Effect.exit(
        manager.write({ sessionID: "ses_w", handle: info.handle, data: "hi" }),
      )
      expect(exit2._tag).toBe("Failure")
    }),
  )

  it.instance("write to a running child with available stdin succeeds and reports bytes", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const child = makeFakeChild({ pid: 32, exit, stdin: true })
      const info = yield* manager.promote({
        sessionID: "ses_w2",
        command: "x",
        cwd: "/",
        pid: 32,
        stdinAvailable: true,
        child,
      })
      const r = yield* manager.write({
        sessionID: "ses_w2",
        handle: info.handle,
        data: "hi",
        appendNewline: true,
      })
      expect(r).toBeDefined()
      expect(r!.bytesWritten).toBe(3) // "hi\n" = 3 bytes
    }),
  )

  it.instance("poll returns events with monotonic cursor", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const child = makeFakeChild({ pid: 33, exit, stdin: true })
      const info = yield* manager.promote({
        sessionID: "ses_p",
        command: "x",
        cwd: "/",
        pid: 33,
        stdinAvailable: true,
        child,
      })

      // poll on a fresh, empty buffer returns an empty event list and
      // a cursor that hasn't advanced.
      const r1 = yield* manager.poll({ sessionID: "ses_p", handle: info.handle, cursor: 0 })
      expect(r1).toBeDefined()
      expect(r1!.events.length).toBe(0)
      expect(r1!.nextCursor).toBe(0)
    }),
  )

  it.instance("poll on missing handle returns undefined", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const r = yield* manager.poll({
        sessionID: "ses_x",
        handle: ProcessHandle.make("proc_missing"),
        cursor: 0,
      })
      expect(r).toBeUndefined()
    }),
  )
})

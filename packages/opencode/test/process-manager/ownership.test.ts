import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { ProcessAdapter, type ProcessAdapterService } from "../../src/process-manager/adapter"
import { ProcessManager } from "../../src/process-manager/service"
import { ProcessHandle } from "../../src/process-manager/id"
import { ProcessError } from "../../src/process-manager/types"
import { testEffect } from "../lib/effect"

// Same fake-adapter shape the other test files use. The stop list is captured
// in a closure so the ownership tests can assert "no signal went to a record
// the caller didn't own."
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

function makeFakeChild(opts: { pid: number; exit?: Deferred.Deferred<number, never>; stdin?: boolean }) {
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

describe("ProcessManager ownership / session isolation", () => {
  it.instance("info returns undefined for cross-session handles", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const info = yield* manager.promote({
        sessionID: "ses_owner_info",
        command: "x",
        cwd: "/",
        pid: 700,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 700, exit }),
      })

      const cross = yield* manager.info({ sessionID: "ses_other_info", handle: info.handle })
      expect(cross).toBeUndefined()
    }),
  )

  it.instance("info returns undefined for missing handles within the owning session", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const missing = yield* manager.info({
        sessionID: "ses_owner_info",
        handle: ProcessHandle.make("proc_does_not_exist"),
      })
      expect(missing).toBeUndefined()
    }),
  )

  it.instance("poll returns undefined for cross-session handles", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const info = yield* manager.promote({
        sessionID: "ses_owner_poll",
        command: "x",
        cwd: "/",
        pid: 701,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 701, exit }),
      })

      const cross = yield* manager.poll({ sessionID: "ses_other_poll", handle: info.handle, cursor: 0 })
      expect(cross).toBeUndefined()
    }),
  )

  it.instance("poll returns undefined for missing handles within the owning session", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const missing = yield* manager.poll({
        sessionID: "ses_owner_poll",
        handle: ProcessHandle.make("proc_missing_poll"),
        cursor: 0,
      })
      expect(missing).toBeUndefined()
    }),
  )

  it.instance("write returns undefined for cross-session handles (no signal, no side effect)", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const info = yield* manager.promote({
        sessionID: "ses_owner_write",
        command: "x",
        cwd: "/",
        pid: 702,
        stdinAvailable: true,
        child: makeFakeChild({ pid: 702, exit, stdin: true }),
      })

      const stopsBefore = fake.stops.length
      const r = yield* manager.write({
        sessionID: "ses_other_write",
        handle: info.handle,
        data: "should not deliver\n",
        appendNewline: false,
      })
      expect(r).toBeUndefined()
      // Cross-session write must not surface as a NotFound/NotRunning error
      // (it returns undefined instead) AND must not call the adapter.
      expect(fake.stops.length).toBe(stopsBefore)
    }),
  )

  it.instance("write returns undefined for missing handles within the owning session", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const r = yield* manager.write({
        sessionID: "ses_owner_write",
        handle: ProcessHandle.make("proc_missing_write"),
        data: "x",
        appendNewline: false,
      })
      expect(r).toBeUndefined()
    }),
  )

  it.instance("stop fails with NotFound for cross-session handles (no adapter signal)", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const info = yield* manager.promote({
        sessionID: "ses_owner_stop",
        command: "x",
        cwd: "/",
        pid: 703,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 703, exit }),
      })

      const stopsBefore = fake.stops.length
      const exitResult = yield* Effect.exit(
        manager.stop({ sessionID: "ses_other_stop", handle: info.handle }),
      )
      // stop is a fallible operation; the manager surfaces NotFound via
      // ProcessError rather than returning undefined.
      expect(Exit.isFailure(exitResult)).toBe(true)
      if (Exit.isFailure(exitResult)) {
        const err = Cause.squash(exitResult.cause)
        expect(err).toBeInstanceOf(ProcessError)
        if (err instanceof ProcessError) {
          expect(err.reason).toBe("NotFound")
        }
      }
      // The cross-session stop must NOT have signalled the OS process.
      expect(fake.stops.length).toBe(stopsBefore)
    }),
  )

  it.instance("stop fails with NotFound for missing handles within the owning session", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exitResult = yield* Effect.exit(
        manager.stop({
          sessionID: "ses_owner_stop",
          handle: ProcessHandle.make("proc_missing_stop"),
        }),
      )
      expect(Exit.isFailure(exitResult)).toBe(true)
      if (Exit.isFailure(exitResult)) {
        const err = Cause.squash(exitResult.cause)
        expect(err).toBeInstanceOf(ProcessError)
        if (err instanceof ProcessError) {
          expect(err.reason).toBe("NotFound")
        }
      }
    }),
  )

  it.instance("list for sessionB never includes sessionA's records", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exitA = yield* Deferred.make<number, never>()
      const exitB = yield* Deferred.make<number, never>()
      const aInfo = yield* manager.promote({
        sessionID: "ses_list_a",
        command: "x",
        cwd: "/",
        pid: 800,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 800, exit: exitA }),
      })
      yield* manager.promote({
        sessionID: "ses_list_b",
        command: "x",
        cwd: "/",
        pid: 801,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 801, exit: exitB }),
      })

      const listB = yield* manager.list({ sessionID: "ses_list_b" })
      // Only sessionB's record is visible; sessionA's handle must not leak.
      const handles = listB.map((r) => r.handle)
      expect(handles).not.toContain(aInfo.handle)
      expect(handles.length).toBe(1)
    }),
  )
})

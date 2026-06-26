import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
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

  it.instance("prePromoteOutput stdout is pollable immediately after promote", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const child = makeFakeChild({ pid: 51, exit, stdin: true })
      const info = yield* manager.promote({
        sessionID: "ses_pre_stdout",
        command: "x",
        cwd: "/",
        pid: 51,
        stdinAvailable: true,
        child,
        prePromoteOutput: { stdout: "hello\n", stderr: "" },
      })

      const r = yield* manager.poll({ sessionID: "ses_pre_stdout", handle: info.handle, cursor: 0 })
      expect(r).toBeDefined()
      expect(r!.events.length).toBe(1)
      expect(r!.events[0]!.text).toBe("hello\n")
      expect(r!.events[0]!.kind).toBe("stdout")
      expect(r!.nextCursor).toBeGreaterThan(0)
    }),
  )

  it.instance("list hides terminal records but they stay readable by handle until TTL", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const info = yield* manager.promote({
        sessionID: "ses_terminal_poll",
        command: "x",
        cwd: "/",
        pid: 55,
        stdinAvailable: true,
        child: makeFakeChild({ pid: 55 }),
        prePromoteOutput: { stdout: "done\n", stderr: "" },
      })
      yield* Effect.sleep("20 millis")

      // `list` is live-only, so a terminal record is hidden from it...
      expect(yield* manager.list({ sessionID: "ses_terminal_poll" })).toEqual([])
      // ...but `poll` still returns its final output and the record is NOT
      // removed on poll (it persists until the TTL purge), so capture fibers
      // can never be interrupted mid-drain and final output is never lost.
      const r = yield* manager.poll({ sessionID: "ses_terminal_poll", handle: info.handle, cursor: 0 })
      expect(r).toBeDefined()
      expect(r!.info.state).toBe("exited")
      expect(r!.events.map((e) => e.text)).toEqual(["done\n"])
      expect(yield* manager.info({ sessionID: "ses_terminal_poll", handle: info.handle })).toBeDefined()
      // A second poll still works because the record was retained.
      const again = yield* manager.poll({ sessionID: "ses_terminal_poll", handle: info.handle, cursor: 0 })
      expect(again!.events.map((e) => e.text)).toEqual(["done\n"])
    }),
  )

  it.instance("prePromoteOutput stderr is pollable and tagged kind=stderr", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const child = makeFakeChild({ pid: 52, exit, stdin: true })
      const info = yield* manager.promote({
        sessionID: "ses_pre_stderr",
        command: "x",
        cwd: "/",
        pid: 52,
        stdinAvailable: true,
        child,
        prePromoteOutput: { stdout: "", stderr: "boom\n" },
      })

      const r = yield* manager.poll({ sessionID: "ses_pre_stderr", handle: info.handle, cursor: 0 })
      expect(r).toBeDefined()
      expect(r!.events.length).toBe(1)
      expect(r!.events[0]!.text).toBe("boom\n")
      expect(r!.events[0]!.kind).toBe("stderr")
    }),
  )

  it.instance("pre + post chunks don't duplicate and seq is monotonic", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const child = makeFakeChild({ pid: 53, exit, stdin: true })
      const info = yield* manager.promote({
        sessionID: "ses_pre_post",
        command: "x",
        cwd: "/",
        pid: 53,
        stdinAvailable: true,
        child,
        prePromoteOutput: { stdout: "pre", stderr: "" },
      })

      const accepted = yield* manager.feed({
        sessionID: "ses_pre_post",
        handle: info.handle,
        kind: "stdout",
        text: "post",
      })
      expect(accepted).toBe(true)

      const r = yield* manager.poll({ sessionID: "ses_pre_post", handle: info.handle, cursor: 0 })
      expect(r).toBeDefined()
      expect(r!.events.length).toBe(2)
      expect(r!.events.map((e) => e.text)).toEqual(["pre", "post"])
      expect(r!.events[0]!.seq).toBeLessThan(r!.events[1]!.seq)
      expect(r!.events[0]!.seq).toBe(1)
      expect(r!.events[1]!.seq).toBe(2)
    }),
  )

  it.instance("prePromoteOutput null/omitted is a no-op for poll", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const child = makeFakeChild({ pid: 54, exit, stdin: true })
      const info = yield* manager.promote({
        sessionID: "ses_pre_none",
        command: "x",
        cwd: "/",
        pid: 54,
        stdinAvailable: true,
        child,
      })

      const r = yield* manager.poll({ sessionID: "ses_pre_none", handle: info.handle, cursor: 0 })
      expect(r).toBeDefined()
      expect(r!.events.length).toBe(0)
    }),
  )

  it.instance("immediate poll (no waitMs) reports waitStatus immediate", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const child = makeFakeChild({ pid: 8100, exit, stdin: true })
      const info = yield* manager.promote({
        sessionID: "ses_immediate",
        command: "x",
        cwd: "/",
        pid: 8100,
        stdinAvailable: true,
        child,
      })
      const r = yield* manager.poll({ sessionID: "ses_immediate", handle: info.handle, cursor: 0 })
      expect(r).toBeDefined()
      expect(r!.waitStatus).toBe("immediate")
    }),
  )

  it.instance("long poll returns when output is appended before the deadline", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const child = makeFakeChild({ pid: 8200, exit, stdin: true })
      const info = yield* manager.promote({
        sessionID: "ses_long_output",
        command: "x",
        cwd: "/",
        pid: 8200,
        stdinAvailable: true,
        child,
      })
      // Park a long poll, then feed output from a sibling fiber. The append
      // wakes the poller well before the 300s deadline.
      const fiber = yield* manager
        .poll({ sessionID: "ses_long_output", handle: info.handle, cursor: 0, waitMs: 300_000 })
        .pipe(Effect.forkChild)
      yield* Effect.sleep("20 millis")
      yield* manager.feed({ sessionID: "ses_long_output", handle: info.handle, kind: "stdout", text: "done" })
      const r = yield* Fiber.join(fiber)
      expect(r).toBeDefined()
      expect(r!.events.length).toBe(1)
      expect(r!.events[0]!.text).toBe("done")
      expect(r!.waitStatus).toBe("output")
    }),
  )

  it.instance("long poll returns when the process exits before the deadline", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const exit = yield* Deferred.make<number, never>()
      const child = makeFakeChild({ pid: 8300, exit, stdin: true })
      const info = yield* manager.promote({
        sessionID: "ses_long_terminal",
        command: "x",
        cwd: "/",
        pid: 8300,
        stdinAvailable: true,
        child,
      })
      const fiber = yield* manager
        .poll({ sessionID: "ses_long_terminal", handle: info.handle, cursor: 0, waitMs: 300_000 })
        .pipe(Effect.forkChild)
      yield* Effect.sleep("20 millis")
      // Resolve the child's exit; the exit watcher flips the record to
      // "exited" and wakes the parked poller.
      yield* Deferred.succeed(exit, 0)
      const r = yield* Fiber.join(fiber)
      expect(r).toBeDefined()
      expect(r!.events.length).toBe(0)
      expect(r!.info.state).toBe("exited")
      expect(r!.waitStatus).toBe("terminal")
    }),
  )
})

describe("normalizePollWaitMs", () => {
  test("clamps to Codex empty-poll bounds", () => {
    expect(ProcessManager.normalizePollWaitMs(undefined)).toBe(0)
    expect(ProcessManager.normalizePollWaitMs(0)).toBe(0)
    expect(ProcessManager.normalizePollWaitMs(1)).toBe(5000)
    expect(ProcessManager.normalizePollWaitMs(4999)).toBe(5000)
    expect(ProcessManager.normalizePollWaitMs(5000)).toBe(5000)
    expect(ProcessManager.normalizePollWaitMs(300000)).toBe(300000)
    expect(ProcessManager.normalizePollWaitMs(300001)).toBe(300000)
  })
})

describe("ProcessManager global cap pruning wakes long polls", () => {
  it.instance("removeRecord({ stopLive: true }) wakes a parked long poll as terminal", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const sessionID = "ses_cap_prune_long_poll"
      // Step 1: promote a live victim that the test will park a long poll on.
      const victimExit = yield* Deferred.make<number, never>()
      const victimInfo = yield* manager.promote({
        sessionID,
        command: "victim",
        cwd: "/",
        pid: 7000,
        stdinAvailable: true,
        child: makeFakeChild({ pid: 7000, exit: victimExit }),
      })
      // Step 2: park a long poll on the victim handle. Use a 300_000ms
      // wait so the only way this returns quickly is via wake.
      const parked = yield* manager
        .poll({ sessionID, handle: victimInfo.handle, cursor: 0, waitMs: 300_000 })
        .pipe(Effect.forkChild)
      // Give the poller a moment to enter the parked state.
      yield* Effect.sleep("20 millis")
      // Step 3: fill the global cap (64) with live records in the same
      // session. The cap pruner prefers a terminal victim; only when no
      // terminal record is available does it fall back to a live victim
      // owned by the promoting session. Promoting 63 more live records
      // here means the 64th live promote (the next step) will prune the
      // victim — the oldest unprotected live record in this session.
      for (let i = 0; i < 63; i++) {
        const exit = yield* Deferred.make<number, never>()
        yield* manager.promote({
          sessionID,
          command: `filler-${i}`,
          cwd: "/",
          pid: 8000 + i,
          stdinAvailable: false,
          child: makeFakeChild({ pid: 8000 + i, exit }),
        })
      }
      // Step 4: the 65th live promote trips the cap. The cap pruner walks
      // unprotected records (oldest 56 by `lastUsedAt`); the victim is
      // the oldest live record in this session because all `lastUsedAt`
      // values equal their `startedAt` and the victim was promoted first.
      const triggerExit = yield* Deferred.make<number, never>()
      yield* manager.promote({
        sessionID,
        command: "trigger",
        cwd: "/",
        pid: 9000,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 9000, exit: triggerExit }),
      })
      // Step 5: the parked long poll must return without waiting the
      // 300_000ms deadline. Wait for the fiber with a 5s safety budget so
      // a regression surfaces as a deterministic test failure rather than
      // a hung suite.
      const result = yield* Fiber.join(parked).pipe(Effect.timeout("5 seconds"))
      // Step 6: assert the wake result. The `?? rec` fallback in
      // `poll.observe()` must observe the mutated-in-place terminal
      // snapshot — i.e. `info.state === "stopped"`, NOT stale `running`.
      expect(result).toBeDefined()
      expect(result!.waitStatus).toBe("terminal")
      expect(result!.waitStatus).not.toBe("timeout")
      expect(result!.info.state).toBe("stopped")
      expect(result!.info.state).not.toBe("running")
      expect(result!.info.terminationReason).toBe("stopped")
    }),
  )

  it.instance("removeRecord({ stopLive: true }) also wakes a pid:null live victim as terminal", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const sessionID = "ses_cap_prune_long_poll_pidless"
      // The previous implementation gated the entire stopLive path on
      // `pid !== null`, so a pidless live victim would have been silently
      // skipped: no mutate, no wake, and the parked long poll would have
      // slept through the 300s deadline. This test pins the fix.
      const victimExit = yield* Deferred.make<number, never>()
      const victimInfo = yield* manager.promote({
        sessionID,
        command: "victim-pidless",
        cwd: "/",
        pid: null,
        stdinAvailable: false,
        child: {
          pid: null,
          exitCode: Effect.flatMap(Deferred.await(victimExit), (n) => Effect.succeed(n)),
          kill: () => {},
        },
      })
      const parked = yield* manager
        .poll({ sessionID, handle: victimInfo.handle, cursor: 0, waitMs: 300_000 })
        .pipe(Effect.forkChild)
      yield* Effect.sleep("20 millis")
      // Fill the global cap (64) with live records in the same session.
      // All fillers use pid:null too so the cap pruner sees no terminal
      // victim available and falls back to the oldest live victim in
      // this session — which is the one we just parked a poll on.
      for (let i = 0; i < 63; i++) {
        const exit = yield* Deferred.make<number, never>()
        yield* manager.promote({
          sessionID,
          command: `filler-${i}`,
          cwd: "/",
          pid: null,
          stdinAvailable: false,
          child: {
            pid: null,
            exitCode: Effect.flatMap(Deferred.await(exit), (n) => Effect.succeed(n)),
            kill: () => {},
          },
        })
      }
      // The 65th live promote trips the cap. No terminal victim exists
      // and all entries share the same session, so the oldest unprotected
      // live record — the victim — is selected.
      const triggerExit = yield* Deferred.make<number, never>()
      yield* manager.promote({
        sessionID,
        command: "trigger",
        cwd: "/",
        pid: null,
        stdinAvailable: false,
        child: {
          pid: null,
          exitCode: Effect.flatMap(Deferred.await(triggerExit), (n) => Effect.succeed(n)),
          kill: () => {},
        },
      })
      // Parked long poll must return within 5s. No adapter.stop is
      // callable for a pidless record, but the wake path must still fire.
      const result = yield* Fiber.join(parked).pipe(Effect.timeout("5 seconds"))
      expect(result).toBeDefined()
      expect(result!.waitStatus).toBe("terminal")
      expect(result!.waitStatus).not.toBe("timeout")
      expect(result!.info.state).toBe("stopped")
      expect(result!.info.state).not.toBe("running")
      expect(result!.info.pid).toBeNull()
      expect(result!.info.terminationReason).toBe("stopped")
    }),
  )
})

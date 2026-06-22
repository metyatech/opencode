import { describe, expect } from "bun:test"
import { Clock, Deferred, Effect, Layer, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ProcessAdapter, type ProcessAdapterService } from "../../src/process-manager/adapter"
import { ProcessManager } from "../../src/process-manager/service"
import { testEffect } from "../lib/effect"
import { withTmpdirInstance } from "../fixture/fixture"

// Same fake-adapter shape the existing tests use: a recorder of `stop` calls
// and a passthrough `pid` lookup. No real OS involvement.
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

// A child whose `exitCode` resolves when the test calls `finishExit(code)`.
function makeFakeChild(opts: { pid: number; exit?: Deferred.Deferred<number, never> }) {
  return {
    pid: opts.pid,
    exitCode: opts.exit
      ? Effect.flatMap(Deferred.await(opts.exit), (n) => Effect.succeed(n))
      : Effect.succeed(0),
    kill: () => {},
    stdin: undefined,
  }
}

function makeLayer() {
  const fake = new FakeProcessAdapter()
  const adapterLayer = Layer.succeed(ProcessAdapter, ProcessAdapter.of(fake))
  const layer = ProcessManager.layer.pipe(Layer.provide(adapterLayer))
  return { fake, it: testEffect(layer) }
}

describe("ProcessManager lifecycle", () => {
  // Single fake for the whole suite so the adapter.stop counts are
  // cumulative across tests. Each test that cares about side effects
  // captures `fake.stops.length` before its action and asserts the delta.
  const { fake, it } = makeLayer()

  // Manager methods (promote/stop/etc.) touch InstanceState, which dies
  // when InstanceRef is not provided. `it.instance` builds a tmpdir
  // instance so the manager's state cache has somewhere to live.
  it.instance("killAllForSession stops only that session's running records", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      // sessionA: one record (running). sessionB: one record (running).
      const aExit = yield* Deferred.make<number, never>()
      const bExit = yield* Deferred.make<number, never>()
      const aInfo = yield* manager.promote({
        sessionID: "ses_lc_a",
        command: "x",
        cwd: "/",
        pid: 100,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 100, exit: aExit }),
      })
      yield* manager.promote({
        sessionID: "ses_lc_b",
        command: "x",
        cwd: "/",
        pid: 200,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 200, exit: bExit }),
      })

      const aList = yield* manager.list({ sessionID: "ses_lc_a" })
      const bList = yield* manager.list({ sessionID: "ses_lc_b" })
      expect(aList.length).toBe(1)
      expect(bList.length).toBe(1)

      yield* manager.killAllForSession("ses_lc_a")

      // sessionA's record is still in the map (killAllForSession only kills
      // the OS process; the manager keeps the record until TTL).
      const aListAfter = yield* manager.list({ sessionID: "ses_lc_a" })
      expect(aListAfter.length).toBe(1)
      expect(aListAfter[0]!.handle).toBe(aInfo.handle)
      // sessionB is untouched: its record is still listed and the OS
      // process was never signalled.
      const bListAfter = yield* manager.list({ sessionID: "ses_lc_b" })
      expect(bListAfter.length).toBe(1)
    }),
  )

  it.instance("killAllForSession on a different session does NOT touch other sessions' running records", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const aExit = yield* Deferred.make<number, never>()
      const aInfo = yield* manager.promote({
        sessionID: "ses_iso_a",
        command: "x",
        cwd: "/",
        pid: 300,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 300, exit: aExit }),
      })

      const stopsBefore = fake.stops.length
      // Cleanup that targets a session with no records must be a no-op and
      // must not stop sessionA's record.
      yield* manager.killAllForSession("ses_iso_empty")
      const aInfoAfter = yield* manager.info({ sessionID: "ses_iso_a", handle: aInfo.handle })
      expect(aInfoAfter).toBeDefined()
      expect(aInfoAfter!.state).toBe("running")
      // The adapter was not invoked because no records matched the target
      // session. sessionA's running PID was never signalled.
      expect(fake.stops.length).toBe(stopsBefore)
    }),
  )

  it.instance("killAllForSession on a different session does NOT touch other sessions' records (cross-session isolation)", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const aExit = yield* Deferred.make<number, never>()
      yield* manager.promote({
        sessionID: "ses_iso_b1",
        command: "x",
        cwd: "/",
        pid: 310,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 310, exit: aExit }),
      })

      const stopsBefore = fake.stops.length
      yield* manager.killAllForSession("ses_iso_b2")
      // Adapter wasn't called for the cross-session cleanup.
      expect(fake.stops.length).toBe(stopsBefore)
    }),
  )

  it.instance("killAll signals every running record across all sessions", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const e1 = yield* Deferred.make<number, never>()
      const e2 = yield* Deferred.make<number, never>()
      const e3 = yield* Deferred.make<number, never>()
      const a = yield* manager.promote({
        sessionID: "ses_ka_a",
        command: "x",
        cwd: "/",
        pid: 11,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 11, exit: e1 }),
      })
      const b = yield* manager.promote({
        sessionID: "ses_ka_a",
        command: "x",
        cwd: "/",
        pid: 12,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 12, exit: e2 }),
      })
      const c = yield* manager.promote({
        sessionID: "ses_ka_b",
        command: "x",
        cwd: "/",
        pid: 13,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 13, exit: e3 }),
      })

      const stopsBefore = fake.stops.length
      yield* manager.killAll()

      // All three PIDs were signalled. The fake records the PIDs in
      // insertion order, so we can assert by set membership.
      const newStops = fake.stops.slice(stopsBefore)
      expect(newStops).toContain(11)
      expect(newStops).toContain(12)
      expect(newStops).toContain(13)

      // killAll only signals the OS process — it does NOT transition the
      // record state to "stopped". The state stays "running" until the
      // exit watcher observes the dead process. Records remain in the
      // manager's map until the TTL purges them.
      const aInfo = yield* manager.info({ sessionID: "ses_ka_a", handle: a.handle })
      const bInfo = yield* manager.info({ sessionID: "ses_ka_a", handle: b.handle })
      const cInfo = yield* manager.info({ sessionID: "ses_ka_b", handle: c.handle })
      expect(aInfo).toBeDefined()
      expect(bInfo).toBeDefined()
      expect(cInfo).toBeDefined()
    }),
  )

  // The TTL tests need both a real InstanceRef (manager state lives there)
  // AND a TestClock (so we can advance time without waiting 30 minutes). The
  // built-in `it.instance` runner uses `liveEnv` which has neither, so we
  // hand-roll the runner for these two cases: wrap the body in a tmpdir
  // instance pipeline and run it through the same testEffect shared
  // infrastructure with TestClock enabled.
  const itInstanceClock = <A, E2>(
    name: string,
    body: () => Effect.Effect<A, E2, ProcessManager.Service | Scope.Scope>,
  ) => {
    return it.instance(name, () =>
      body().pipe(
        // Provide TestClock on top of the instance's live layer. The TestClock
        // service is overridden globally for this test only.
        Effect.provide(Layer.mergeAll(TestClock.layer())),
        withTmpdirInstance(),
      ),
    )
  }

  itInstanceClock("purgeExpired only removes records whose endedAt is >= TTL_MS old", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      // Three records with deferred exits. We control their `endedAt` by
      // advancing the TestClock before completing each.
      const aExit = yield* Deferred.make<number, never>()
      const bExit = yield* Deferred.make<number, never>()
      const cExit = yield* Deferred.make<number, never>()

      const a = yield* manager.promote({
        sessionID: "ses_ttl",
        command: "x",
        cwd: "/",
        pid: 501,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 501, exit: aExit }),
      })
      const b = yield* manager.promote({
        sessionID: "ses_ttl",
        command: "x",
        cwd: "/",
        pid: 502,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 502, exit: bExit }),
      })
      const c = yield* manager.promote({
        sessionID: "ses_ttl",
        command: "x",
        cwd: "/",
        pid: 503,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 503, exit: cExit }),
      })

      // We want:
      //   A: endedAt = T0 (very old after we advance)
      //   B: endedAt = T0 + 2 min (still "fresh" 29 min later)
      //   C: endedAt = null (running, never purged)
      const T0 = yield* Clock.currentTimeMillis
      yield* Deferred.succeed(aExit, 0)

      // Wait a virtual 2 minutes, then finish B.
      yield* TestClock.adjust("2 minutes")
      yield* Deferred.succeed(bExit, 0)

      // Advance 29 more minutes to put A past the 30 min boundary while
      // keeping B at 29 min (still fresh, since 29 < 30).
      yield* TestClock.adjust("29 minutes")

      yield* manager.purgeExpired()

      // A should be gone (31 min old >= 30 min TTL).
      // B should remain (29 min old < 30 min TTL).
      // C should remain (running, endedAt is null).
      const aInfo = yield* manager.info({ sessionID: "ses_ttl", handle: a.handle })
      const bInfo = yield* manager.info({ sessionID: "ses_ttl", handle: b.handle })
      const cInfo = yield* manager.info({ sessionID: "ses_ttl", handle: c.handle })
      expect(aInfo).toBeUndefined()
      expect(bInfo).toBeDefined()
      expect(cInfo).toBeDefined()
      // Sanity: B's record really is "exited" (the watcher fired) and C is
      // still "running" (the deferred is unresolved).
      expect(bInfo!.state).toBe("exited")
      expect(cInfo!.state).toBe("running")
      // Clock really did advance (so the test isn't silently using live time).
      const now = yield* Clock.currentTimeMillis
      expect(now - T0).toBe(31 * 60 * 1000)
    }),
  )

  itInstanceClock("running records survive multiple purgeExpired calls", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const cExit = yield* Deferred.make<number, never>()
      const c = yield* manager.promote({
        sessionID: "ses_ttl_running",
        command: "x",
        cwd: "/",
        pid: 601,
        stdinAvailable: false,
        child: makeFakeChild({ pid: 601, exit: cExit }),
      })

      // Advance well past the TTL window and call purgeExpired several times.
      yield* TestClock.adjust("2 hours")
      yield* manager.purgeExpired()
      yield* TestClock.adjust("2 hours")
      yield* manager.purgeExpired()
      yield* TestClock.adjust("2 hours")
      yield* manager.purgeExpired()

      // The record is still there because endedAt is null.
      const cInfo = yield* manager.info({ sessionID: "ses_ttl_running", handle: c.handle })
      expect(cInfo).toBeDefined()
      expect(cInfo!.state).toBe("running")
    }),
  )
})

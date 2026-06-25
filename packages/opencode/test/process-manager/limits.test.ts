import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { ProcessAdapter, type ProcessAdapterService } from "../../src/process-manager/adapter"
import { MAX_GLOBAL, RECENT_PROCESS_PROTECT_COUNT } from "../../src/process-manager/service"
import { ProcessManager } from "../../src/process-manager/service"
import type { ProcessInfo } from "../../src/process-manager/types"
import { testEffect } from "../lib/effect"

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

function makeLiveChild(pid: number, exit: Deferred.Deferred<number, never>) {
  return {
    pid,
    exitCode: Effect.flatMap(Deferred.await(exit), (code) => Effect.succeed(code)),
    kill: () => {},
    stdin: undefined,
  }
}

function makeExitedChild(pid: number) {
  return {
    pid,
    exitCode: Effect.succeed(0),
    kill: () => {},
    stdin: undefined,
  }
}

const fake = new FakeProcessAdapter()
const adapterLayer = Layer.succeed(ProcessAdapter, ProcessAdapter.of(fake))
const it = testEffect(ProcessManager.layer.pipe(Layer.provide(adapterLayer)))

describe("ProcessManager limits", () => {
  it.instance("allows 64 live processes in one session", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const sessionID = "ses_sixty_four"

      for (let i = 0; i < MAX_GLOBAL; i++) {
        yield* manager.promote({
          sessionID,
          command: `cmd${i}`,
          cwd: "/",
          pid: 1000 + i,
          stdinAvailable: false,
          child: makeLiveChild(1000 + i, yield* Deferred.make<number, never>()),
        })
      }

      const list = yield* manager.list({ sessionID })
      expect(list.length).toBe(MAX_GLOBAL)
    }),
  )

  it.instance("prunes the least-recently-used live process instead of rejecting the 65th promote", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const sessionID = "ses_prune_live"
      const handles: ProcessInfo[] = []

      for (let i = 0; i < MAX_GLOBAL; i++) {
        handles.push(
          yield* manager.promote({
            sessionID,
            command: `cmd${i}`,
            cwd: "/",
            pid: 2000 + i,
            stdinAvailable: false,
            child: makeLiveChild(2000 + i, yield* Deferred.make<number, never>()),
          }),
        )
      }

      const promoted = yield* manager.promote({
        sessionID,
        command: "extra",
        cwd: "/",
        pid: 2999,
        stdinAvailable: false,
        child: makeLiveChild(2999, yield* Deferred.make<number, never>()),
      })

      expect(promoted.state).toBe("running")
      expect(fake.stops).toContain(2000)
      expect(yield* manager.info({ sessionID, handle: handles[0]!.handle })).toBeUndefined()
      expect((yield* manager.list({ sessionID })).length).toBe(MAX_GLOBAL)
    }),
  )

  it.instance("prefers pruning an old terminal process over a live process", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const sessionID = "ses_prune_terminal"
      const terminal = yield* manager.promote({
        sessionID,
        command: "done",
        cwd: "/",
        pid: 3000,
        stdinAvailable: false,
        child: makeExitedChild(3000),
      })

      for (let i = 1; i < MAX_GLOBAL; i++) {
        yield* manager.promote({
          sessionID,
          command: `cmd${i}`,
          cwd: "/",
          pid: 3000 + i,
          stdinAvailable: false,
          child: makeLiveChild(3000 + i, yield* Deferred.make<number, never>()),
        })
      }
      yield* Effect.sleep("20 millis")

      const beforeStops = fake.stops.length
      yield* manager.promote({
        sessionID,
        command: "extra",
        cwd: "/",
        pid: 3999,
        stdinAvailable: false,
        child: makeLiveChild(3999, yield* Deferred.make<number, never>()),
      })

      expect(fake.stops.length).toBe(beforeStops)
      expect(yield* manager.info({ sessionID, handle: terminal.handle })).toBeUndefined()
      expect((yield* manager.list({ sessionID })).length).toBe(MAX_GLOBAL)
    }),
  )

  it.instance("protects the 8 most recently used processes during prune", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const sessionID = "ses_prune_protected"
      const handles: ProcessInfo[] = []

      for (let i = 0; i < MAX_GLOBAL; i++) {
        handles.push(
          yield* manager.promote({
            sessionID,
            command: `cmd${i}`,
            cwd: "/",
            pid: 4000 + i,
            stdinAvailable: false,
            child: makeLiveChild(4000 + i, yield* Deferred.make<number, never>()),
          }),
        )
      }
      for (let i = 0; i < RECENT_PROCESS_PROTECT_COUNT; i++) {
        yield* manager.poll({ sessionID, handle: handles[i]!.handle, cursor: 0 })
      }

      yield* manager.promote({
        sessionID,
        command: "extra",
        cwd: "/",
        pid: 4999,
        stdinAvailable: false,
        child: makeLiveChild(4999, yield* Deferred.make<number, never>()),
      })

      for (let i = 0; i < RECENT_PROCESS_PROTECT_COUNT; i++) {
        expect(yield* manager.info({ sessionID, handle: handles[i]!.handle })).toBeDefined()
        expect(fake.stops).not.toContain(4000 + i)
      }
      expect(fake.stops).toContain(4000 + RECENT_PROCESS_PROTECT_COUNT)
    }),
  )

  it.instance("never stops another session's live process to make room for a promote", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const victimSession = "ses_victim"
      const attackerSession = "ses_attacker"
      const victimHandles: ProcessInfo[] = []

      // Session A fills the entire global store with live processes.
      for (let i = 0; i < MAX_GLOBAL; i++) {
        victimHandles.push(
          yield* manager.promote({
            sessionID: victimSession,
            command: `victim${i}`,
            cwd: "/",
            pid: 6000 + i,
            stdinAvailable: false,
            child: makeLiveChild(6000 + i, yield* Deferred.make<number, never>()),
          }),
        )
      }

      // Session B promotes into a full store. There is no terminal record to
      // prune and session B owns no live record, so the promote MUST be
      // rejected — session A's running jobs must never be stopped to make
      // room for session B.
      const beforeStops = fake.stops.length
      const result = yield* Effect.exit(
        manager.promote({
          sessionID: attackerSession,
          command: "intruder",
          cwd: "/",
          pid: 6999,
          stdinAvailable: false,
          child: makeLiveChild(6999, yield* Deferred.make<number, never>()),
        }),
      )

      expect(result._tag).toBe("Failure")
      // Only the rejected candidate's own pid may be stopped; no victim pid.
      expect(fake.stops).toContain(6999)
      for (let i = 0; i < MAX_GLOBAL; i++) {
        expect(fake.stops).not.toContain(6000 + i)
        expect(yield* manager.info({ sessionID: victimSession, handle: victimHandles[i]!.handle })).toBeDefined()
      }
      expect((yield* manager.list({ sessionID: victimSession })).length).toBe(MAX_GLOBAL)
      void beforeStops
    }),
  )
})

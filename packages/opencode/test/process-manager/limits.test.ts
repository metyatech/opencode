import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ProcessAdapter, type ProcessAdapterService } from "../../src/process-manager/adapter"
import { ProcessManager } from "../../src/process-manager/service"
import { MAX_GLOBAL, MAX_PER_SESSION } from "../../src/process-manager/service"
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

function makeFakeChild(pid: number) {
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
  it.instance("rejects the (MAX_PER_SESSION + 1)-th promote from the same session", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const sessionID = "ses_capped"

      for (let i = 0; i < MAX_PER_SESSION; i++) {
        yield* manager.promote({
          sessionID,
          command: `cmd${i}`,
          cwd: "/",
          pid: 1000 + i,
          stdinAvailable: false,
          child: makeFakeChild(1000 + i),
        })
      }

      const exits: number[] = []
      // Capture which PIDs got killed by the cap-reject path.
      const beforeKills = fake.stops.length
      for (let i = 0; i < 3; i++) {
        const candidatePid = 9000 + i
        const result = yield* Effect.exit(
          manager.promote({
            sessionID,
            command: "extra",
            cwd: "/",
            pid: candidatePid,
            stdinAvailable: false,
            child: makeFakeChild(candidatePid),
          }),
        )
        if (result._tag === "Failure") exits.push(candidatePid)
      }
      // All over-cap promotes were rejected
      expect(exits.length).toBe(3)
      // All those candidate PIDs were killed by the adapter
      for (const pid of exits) {
        expect(fake.stops).toContain(pid)
      }
      // No new records were added to the session
      const list = yield* manager.list({ sessionID })
      expect(list.length).toBe(MAX_PER_SESSION)
    }),
  )

  it.instance("rejects the (MAX_GLOBAL + 1)-th promote across all sessions", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      // Fill up to the global cap by spreading across many sessions.
      // We only need the 33rd promote to be rejected, regardless of session.
      let placed = 0
      let s = 0
      while (placed < MAX_GLOBAL) {
        const sessionID = `ses_g_${s++}`
        yield* manager.promote({
          sessionID,
          command: "x",
          cwd: "/",
          pid: 7000 + placed,
          stdinAvailable: false,
          child: makeFakeChild(7000 + placed),
        })
        placed++
      }
      // Now a 33rd promote from any session is rejected.
      const result = yield* Effect.exit(
        manager.promote({
          sessionID: "ses_g_99",
          command: "x",
          cwd: "/",
          pid: 9999,
          stdinAvailable: false,
          child: makeFakeChild(9999),
        }),
      )
      expect(result._tag).toBe("Failure")
      // And that PID was killed
      expect(fake.stops).toContain(9999)
    }),
  )

  it.instance("the over-cap child is killed by the adapter even though the record is dropped", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const sessionID = "ses_kill"
      for (let i = 0; i < MAX_PER_SESSION; i++) {
        yield* manager.promote({
          sessionID,
          command: "x",
          cwd: "/",
          pid: 5000 + i,
          stdinAvailable: false,
          child: makeFakeChild(5000 + i),
        })
      }
      const overPid = 5555
      const before = fake.stops.length
      yield* Effect.exit(
        manager.promote({
          sessionID,
          command: "x",
          cwd: "/",
          pid: overPid,
          stdinAvailable: false,
          child: makeFakeChild(overPid),
        }),
      )
      // adapter.stop was called for the over-cap PID
      expect(fake.stops.length).toBe(before + 1)
      expect(fake.stops).toContain(overPid)
    }),
  )
})

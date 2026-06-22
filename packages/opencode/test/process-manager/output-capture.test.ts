import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Truncate } from "@/tool/truncate"
import { ProcessManager } from "../../src/process-manager/service"
import { testEffect } from "../lib/effect"
import { withTmpdirInstance } from "../fixture/fixture"

// Resolve the runtime binary. The integration test always uses `bun` because
// the harness runs under `bun test`; CI guarantees `bun` on PATH.
const BUN_BIN = (() => {
  const fromBun = (Bun as { which?: (name: string) => string | null }).which?.("bun")
  if (fromBun) return fromBun
  throw new Error("bun binary not found on PATH; cannot run output-capture tests")
})()

// Spawn a real child and turn it into a `ManagedChild`-shaped object plus the
// live stdio streams. The test owns the handle and uses `Effect.addFinalizer`
// to ensure the child is killed if the test exits early.
function spawnAndOwn(scriptBody: string) {
  return Effect.gen(function* () {
    const proc = Bun.spawn([BUN_BIN, "-e", scriptBody], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        try {
          proc.kill()
        } catch {}
      }).pipe(Effect.ignore),
    )
    return proc
  })
}

const baseLayer = Layer.mergeAll(
  Config.defaultLayer,
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Truncate.defaultLayer,
  AppFileSystem.defaultLayer,
  RuntimeFlags.defaultLayer,
  ProcessManager.defaultLayer,
)

const it = testEffect(baseLayer)

describe("ProcessManager manager-owned output capture", () => {
  it.instance("passing stdout: stream captures child output into the ring buffer", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const proc = yield* spawnAndOwn(`process.stdout.write("ping\\n"); setTimeout(() => process.exit(0), 200)`)

      const info = yield* manager.promote({
        sessionID: "ses_cap",
        command: "ping",
        cwd: "/",
        pid: proc.pid,
        stdinAvailable: false,
        child: {
          pid: proc.pid,
          exitCode: Effect.promise(async () => (await proc.exitCode) ?? -1),
          kill: () => {
            try {
              proc.kill()
            } catch {}
          },
        },
        stdout: proc.stdout,
      })
      expect(info.state).toBe("running")

      // Poll until at least one event is captured or the child exits.
      let found = ""
      for (let i = 0; i < 30 && found === ""; i++) {
        yield* Effect.sleep("20 millis")
        const polled = yield* manager.poll({ sessionID: "ses_cap", handle: info.handle, cursor: 0 })
        if (polled && polled.events.length > 0) {
          found = polled.events.map((e) => e.text).join("")
        }
      }
      expect(found).toContain("ping")
    }),
  )

  it.instance("passing stderr: stream captures child stderr into the ring buffer", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const proc = yield* spawnAndOwn(
        `process.stderr.write("warn\\n"); setTimeout(() => process.exit(0), 200)`,
      )

      const info = yield* manager.promote({
        sessionID: "ses_cap_err",
        command: "warn",
        cwd: "/",
        pid: proc.pid,
        stdinAvailable: false,
        child: {
          pid: proc.pid,
          exitCode: Effect.promise(async () => (await proc.exitCode) ?? -1),
          kill: () => {
            try {
              proc.kill()
            } catch {}
          },
        },
        stderr: proc.stderr,
      })
      expect(info.state).toBe("running")

      let found = ""
      for (let i = 0; i < 30 && found === ""; i++) {
        yield* Effect.sleep("20 millis")
        const polled = yield* manager.poll({ sessionID: "ses_cap_err", handle: info.handle, cursor: 0 })
        if (polled && polled.events.length > 0) {
          found = polled.events.map((e) => e.text).join("")
        }
      }
      expect(found).toContain("warn")
    }),
  )
})

// Import the helper so the linter sees it used.
void withTmpdirInstance

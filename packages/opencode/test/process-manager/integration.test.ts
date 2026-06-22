import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Truncate } from "@/tool/truncate"
import { ProcessManager } from "../../src/process-manager/service"
import { testEffect } from "../lib/effect"
import { withTmpdirInstance } from "../fixture/fixture"

// Resolve the runtime binary. The integration test always uses `bun` because
// the harness runs under `bun test`; CI guarantees `bun` on PATH. Falling back
// to `process.execPath` would couple the test to the host's Node install,
// which is the very thing we are trying to avoid here.
const BUN_BIN = (() => {
  // `Bun.which` is the authoritative lookup; it searches PATH the same way
  // a child process would.
  const fromBun = (Bun as { which?: (name: string) => string | null }).which?.("bun")
  if (fromBun) return fromBun
  throw new Error("bun binary not found on PATH; cannot run integration tests")
})()

// Build a `Bun.Subprocess` and turn it into the shape the manager's exit
// watcher expects. We never call `child.kill` directly from the manager's
// adapter — the adapter goes through `ProcessAdapter.stop` (SIGTERM/SIGKILL
// on Unix, `taskkill /pid /f /t` on Windows). The handle's `.kill` is
// only used as a fallback if the manager's exit watcher ever needs to
// short-circuit. We pass a no-op for safety.
function buildManagedChildFromBun(child: ReturnType<typeof Bun.spawn>, stdinAvailable: boolean) {
  const exit: Effect.Effect<number, never, never> = Effect.promise(async () => {
    // Bun.spawn returns a Subprocess whose `.exitCode` resolves when the
    // child exits. The manager treats -1 as "killed before clean exit".
    const code = await child.exitCode
    return typeof code === "number" ? code : -1
  })
  return {
    pid: child.pid,
    exitCode: exit,
    kill: () => {
      // Best-effort fallback. The manager adapter is the authoritative
      // terminator; this only fires if the exit watcher's last-ditch
      // interrupt path runs.
      try {
        child.kill()
      } catch {}
    },
    stdin: stdinAvailable && child.stdin
      ? {
          write: (chunk: string) =>
            Effect.sync(() => {
              const writer = child.stdin as unknown as { write: (data: string) => void }
              writer.write(chunk)
            }),
          close: () =>
            Effect.sync(() => {
              const writer = child.stdin as unknown as { end?: () => void }
              writer.end?.()
            }),
        }
      : undefined,
  }
}

// Spawn a child and register a scope finalizer that kills it if the test
// exits before the child does. The handle returned to the caller is the
// `ManagedChild` shape the manager expects.
function spawnAndOwn(
  args: string[],
  options: { stdin?: "pipe" | "ignore"; env?: Record<string, string> } = {},
) {
  return Effect.gen(function* () {
    const proc = Bun.spawn(args, {
      stdin: options.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...(options.env ?? {}) },
    })
    // Test-owned: if the test exits before the child does, the finalizer
    // kills it. This is the only place we reach for the live OS process.
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

// Drain a `ReadableStream<Uint8Array>` into a list of UTF-8 strings. We use
// this both to feed the manager's buffer (via the `feed` API) and to make
// assertions about what the child wrote.
async function collectLines(stream: ReadableStream<Uint8Array> | null): Promise<string[]> {
  if (!stream) return []
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
    }
    buf += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  return buf.split(/(?<=\n)/).filter((line) => line.length > 0)
}

const baseLayer = Layer.mergeAll(
  Config.defaultLayer,
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Truncate.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  AppFileSystem.defaultLayer,
  RuntimeFlags.defaultLayer,
)

// ProcessManager.defaultLayer bakes in `liveProcessAdapter`, so stop() /
// killAll() route through `taskkill` / `process.kill(-pid, sig)` — the same
// path real production callers use.
const fullLayer = Layer.provideMerge(ProcessManager.defaultLayer, baseLayer)
const it = testEffect(fullLayer)

describe("ProcessManager integration (real children)", () => {
  it.instance("real child stdout flows into the manager's buffer and is pollable", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      const child = yield* spawnAndOwn([BUN_BIN, "-e", `process.stdout.write("hello\\n"); process.stdout.write("world\\n");`])

      // Build the ManagedChild handle for promote(). The manager uses
      // `pid` and `exitCode`; `kill` is the adapter's fallback.
      const managed = buildManagedChildFromBun(child, false)

      // Promote BEFORE waiting for exit so the manager's exit watcher is
      // in flight when the child actually completes.
      const info = yield* manager.promote({
        sessionID: "ses_int_stream",
        command: "echo hello world",
        cwd: process.cwd(),
        pid: child.pid,
        stdinAvailable: false,
        child: managed,
      })

      // Drain the child's stdout into a list of lines, feeding each line
      // into the manager's bounded buffer via the `feed` API. This is the
      // exact flow the shell tool uses — child stdout -> ring buffer.
      const lines = yield* Effect.promise(() => collectLines(child.stdout))
      for (const line of lines) {
        const accepted = yield* manager.feed({
          sessionID: "ses_int_stream",
          handle: info.handle,
          kind: "stdout",
          text: line,
        })
        expect(accepted).toBe(true)
      }

      // Give the child time to finish so the manager's exit watcher has
      // flipped state to `exited` (or `failed`). This is the
      // "yield* after spawn" the spec asks for.
      yield* Effect.promise(() => child.exited)

      const polled = yield* manager.poll({ sessionID: "ses_int_stream", handle: info.handle, cursor: 0 })
      expect(polled).toBeDefined()
      // Both "hello\n" and "world\n" should be in the buffer, in order.
      expect(polled!.events.length).toBeGreaterThanOrEqual(2)
      const texts = polled!.events.map((e) => e.text)
      expect(texts[0]).toBe("hello\n")
      expect(texts[1]).toBe("world\n")
      for (const event of polled!.events) {
        expect(event.kind).toBe("stdout")
      }
      // No truncation occurred: both lines fit in the default 1 MiB buffer.
      expect(polled!.truncatedBeforeCursor).toBe(false)
      // nextCursor must advance to the seq of the last event returned.
      expect(polled!.nextCursor).toBeGreaterThan(0)
      expect(polled!.nextCursor).toBe(polled!.events[polled!.events.length - 1]!.seq)
    }),
  )

  it.instance("write to a real child's stdin is echoed back through poll", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      // The child reads stdin line-by-line and writes it back to stdout,
      // then exits after 200ms regardless of activity.
      const stdinScript = `let buf = ""; process.stdin.on("data", (d) => { buf += d.toString(); }); process.stdin.on("end", () => { process.stdout.write(buf); process.exit(0); }); setTimeout(() => { process.stdout.write(buf); process.exit(0); }, 200);`
      const child = yield* spawnAndOwn([BUN_BIN, "-e", stdinScript], { stdin: "pipe" })

      const managed = buildManagedChildFromBun(child, true)
      const info = yield* manager.promote({
        sessionID: "ses_int_stdin",
        command: "stdin-echo",
        cwd: process.cwd(),
        pid: child.pid,
        stdinAvailable: true,
        child: managed,
      })

      // Write "ping\n" with appendNewline=true. The manager's `write` path
      // appends a "\n" for us, which means the trailing newline we already
      // include in the test data would be doubled. Pass `appendNewline: false`
      // to send exactly "ping\n" (the child expects line-terminated input).
      const wr = yield* manager.write({
        sessionID: "ses_int_stdin",
        handle: info.handle,
        data: "ping\n",
        appendNewline: false,
      })
      expect(wr).toBeDefined()
      expect(wr!.bytesWritten).toBe("ping\n".length)

      // Close stdin so the child can flush its buffer and exit deterministically.
      yield* Effect.sync(() => {
        const w = child.stdin as unknown as { end?: () => void } | null
        w?.end?.()
      })

      // Give the child time to finish + the manager's exit watcher to fire.
      yield* Effect.promise(() => child.exited)
      yield* Effect.sleep("20 millis")

      // Drain stdout and feed it into the manager's buffer so `poll` can
      // surface it.
      const lines = yield* Effect.promise(() => collectLines(child.stdout))
      for (const line of lines) {
        yield* manager.feed({
          sessionID: "ses_int_stdin",
          handle: info.handle,
          kind: "stdout",
          text: line,
        })
      }

      const polled = yield* manager.poll({ sessionID: "ses_int_stdin", handle: info.handle, cursor: 0 })
      expect(polled).toBeDefined()
      const combined = polled!.events.map((e) => e.text).join("")
      expect(combined).toContain("ping")
    }),
  )

  it.instance("stop kills a long-running real child (Windows + POSIX adapter path)", () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.Service
      // The child prints '.' every 100ms and would otherwise run for 60s.
      // stop() must interrupt it well before that.
      const longRunningScript = `setInterval(() => process.stdout.write("."), 100); setTimeout(() => process.exit(0), 60_000);`
      const child = yield* spawnAndOwn([BUN_BIN, "-e", longRunningScript])

      const managed = buildManagedChildFromBun(child, false)
      const info = yield* manager.promote({
        sessionID: "ses_int_stop",
        command: "long-runner",
        cwd: process.cwd(),
        pid: child.pid,
        stdinAvailable: false,
        child: managed,
      })

      // Capture the exit promise so we can await it after stop().
      const exitedPromise = child.exited

      const stopped = yield* manager.stop({ sessionID: "ses_int_stop", handle: info.handle })
      expect(stopped.state).toBe("stopped")

      // The child must exit promptly. We give the OS a generous deadline so
      // a slow CI runner doesn't flake; the adapter's grace window is 200ms
      // and a `taskkill /f` is immediate on Windows.
      const exitCode = yield* Effect.promise(() =>
        Promise.race([
          exitedPromise.then((code) => ({ kind: "exit" as const, code })),
          new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 5_000)),
        ]),
      )
      expect(exitCode.kind).toBe("exit")

      // After stop, the record is "stopped". info() still resolves the
      // record (the manager keeps stopped records until TTL); poll() should
      // report the terminal state.
      const afterInfo = yield* manager.info({ sessionID: "ses_int_stop", handle: info.handle })
      expect(afterInfo).toBeDefined()
      expect(afterInfo!.state).toBe("stopped")
    }),
  )
})

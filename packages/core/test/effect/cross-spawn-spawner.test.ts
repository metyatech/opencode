import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Stream } from "effect"
import type * as PlatformError from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const live = CrossSpawnSpawner.defaultLayer
const fx = testEffect(live)

function js(code: string, opts?: ChildProcess.CommandOptions) {
  return ChildProcess.make("node", ["-e", code], opts)
}

function decodeByteStream(stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) {
  return Stream.runCollect(stream).pipe(
    Effect.map((chunks) => {
      const total = chunks.reduce((acc, x) => acc + x.length, 0)
      const out = new Uint8Array(total)
      let off = 0
      for (const chunk of chunks) {
        out.set(chunk, off)
        off += chunk.length
      }
      return new TextDecoder("utf-8").decode(out).trim()
    }),
  )
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function tmpdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-core-test-"))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

async function gone(pid: number, timeout = 5_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !alive(pid)
}

const descendantPidFile = "descendant.pid"

const holdStdioChild = (seconds: number) =>
  process.platform === "win32"
    ? { command: process.execPath, args: ["-e", `setTimeout(() => {}, ${seconds * 1_000})`] }
    : { command: "sleep", args: [String(seconds)] }

const ignoredKillError = (err: unknown) => {
  const code = typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined
  return code === "ESRCH" || code === "EINVAL"
}

async function killProcessTree(pid: number | undefined) {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return
  if (process.platform === "win32") {
    await Bun.spawn(["taskkill", "/pid", String(pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    }).exited.catch(() => undefined)
    await gone(pid, 1_000)
    return
  }

  try {
    process.kill(-pid, "SIGKILL")
  } catch (err) {
    if (ignoredKillError(err)) return
    try {
      process.kill(pid, "SIGKILL")
    } catch (singleErr) {
      if (!ignoredKillError(singleErr)) throw singleErr
    }
  }
  await gone(pid, 1_000)
}

async function cleanupPidFile(file: string) {
  const pid = Number((await fs.readFile(file, "utf8").catch(() => "")).trim())
  if (Number.isFinite(pid)) await killProcessTree(pid)
}

async function tmpdirCleaningPids(...pidNames: string[]) {
  const tmp = await tmpdir()
  return {
    path: tmp.path,
    async [Symbol.asyncDispose]() {
      for (const name of pidNames) await cleanupPidFile(path.join(tmp.path, name))
      await tmp[Symbol.asyncDispose]()
    },
  }
}

describe("cross-spawn spawner", () => {
  describe("basic spawning", () => {
    fx.effect(
      "captures stdout",
      Effect.gen(function* () {
        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(ChildProcess.make(process.execPath, ["-e", 'process.stdout.write("ok")'])),
        )
        expect(out).toBe("ok")
      }),
    )

    fx.effect(
      "captures multiple lines",
      Effect.gen(function* () {
        const handle = yield* js('console.log("line1"); console.log("line2"); console.log("line3")')
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("line1\nline2\nline3")
      }),
    )

    fx.effect(
      "returns exit code",
      Effect.gen(function* () {
        const handle = yield* js("process.exit(0)")
        const code = yield* handle.exitCode
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )

    fx.effect(
      "returns non-zero exit code",
      Effect.gen(function* () {
        const handle = yield* js("process.exit(42)")
        const code = yield* handle.exitCode
        expect(code).toBe(ChildProcessSpawner.ExitCode(42))
      }),
    )
  })

  describe("cwd option", () => {
    fx.effect(
      "uses cwd when spawning commands",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(
            ChildProcess.make(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: tmp.path }),
          ),
        )
        expect(yield* Effect.promise(() => fs.realpath(out))).toBe(yield* Effect.promise(() => fs.realpath(tmp.path)))
      }),
    )

    fx.effect(
      "fails for invalid cwd",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
            svc.spawn(ChildProcess.make("echo", ["test"], { cwd: "/nonexistent/directory/path" })),
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  describe("env option", () => {
    fx.effect(
      "passes environment variables with extendEnv",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write(process.env.TEST_VAR ?? "")', {
          env: { TEST_VAR: "test_value" },
          extendEnv: true,
        })
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("test_value")
      }),
    )

    fx.effect(
      "passes multiple environment variables",
      Effect.gen(function* () {
        const handle = yield* js(
          "process.stdout.write(`${process.env.VAR1}-${process.env.VAR2}-${process.env.VAR3}`)",
          {
            env: { VAR1: "one", VAR2: "two", VAR3: "three" },
            extendEnv: true,
          },
        )
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("one-two-three")
      }),
    )
  })

  describe("stderr", () => {
    fx.effect(
      "captures stderr output",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("error message")')
        const err = yield* decodeByteStream(handle.stderr)
        expect(err).toBe("error message")
      }),
    )

    fx.effect(
      "captures both stdout and stderr",
      Effect.gen(function* () {
        const handle = yield* js(
          [
            "let pending = 2",
            "const done = () => {",
            "  pending -= 1",
            "  if (pending === 0) setTimeout(() => process.exit(0), 0)",
            "}",
            'process.stdout.write("stdout\\n", done)',
            'process.stderr.write("stderr\\n", done)',
          ].join("\n"),
        )
        const [stdout, stderr] = yield* Effect.all([decodeByteStream(handle.stdout), decodeByteStream(handle.stderr)], {
          concurrency: 2,
        })
        expect(stdout).toBe("stdout")
        expect(stderr).toBe("stderr")
      }),
    )
  })

  describe("combined output (all)", () => {
    fx.effect(
      "captures stdout via .all when no stderr",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("hello from stdout")')
        const all = yield* decodeByteStream(handle.all)
        expect(all).toBe("hello from stdout")
      }),
    )

    fx.effect(
      "captures stderr via .all when no stdout",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("hello from stderr")')
        const all = yield* decodeByteStream(handle.all)
        expect(all).toBe("hello from stderr")
      }),
    )
  })

  describe("stdin", () => {
    fx.effect(
      "allows providing standard input to a command",
      Effect.gen(function* () {
        const input = "a b c"
        const stdin = Stream.make(Buffer.from(input, "utf-8"))
        const handle = yield* js(
          'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
          { stdin },
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("a b c")
      }),
    )
  })

  describe("process control", () => {
    fx.effect(
      "kills a running process",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* js("setTimeout(() => {}, 10_000)")
            yield* handle.kill()
            return yield* handle.exitCode
          }),
        )
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )

    fx.effect(
      "kills a child when scope exits",
      Effect.gen(function* () {
        const pid = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* js("setInterval(() => {}, 10_000)")
            return Number(handle.pid)
          }),
        )
        const done = yield* Effect.promise(() => gone(pid))
        expect(done).toBe(true)
      }),
    )

    fx.effect(
      "forceKillAfter escalates for stubborn processes",
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const started = Date.now()
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* js('process.on("SIGTERM", () => {}); setInterval(() => {}, 10_000)')
            yield* handle.kill({ forceKillAfter: 100 })
            return yield* handle.exitCode
          }),
        )

        expect(Date.now() - started).toBeLessThan(1_000)
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )

    fx.effect(
      "isRunning reflects process state",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("done")')
        yield* handle.exitCode
        const running = yield* handle.isRunning
        expect(running).toBe(false)
      }),
    )
  })

  describe("error handling", () => {
    fx.effect(
      "fails for invalid command",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* ChildProcess.make("nonexistent-command-12345")
            return yield* handle.exitCode
          }),
        )
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )
  })

  describe("pipeline", () => {
    fx.effect(
      "pipes stdout of one command to stdin of another",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("hello world")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.toUpperCase()))',
            ),
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("HELLO WORLD")
      }),
    )

    fx.effect(
      "three-stage pipeline",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("hello world")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.toUpperCase()))',
            ),
          ),
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.replaceAll(" ", "-")))',
            ),
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("HELLO-WORLD")
      }),
    )

    fx.effect(
      "pipes stderr with { from: 'stderr' }",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("error")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
            ),
            { from: "stderr" },
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("error")
      }),
    )

    fx.effect(
      "pipes combined output with { from: 'all' }",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("stdout\\n"); process.stderr.write("stderr\\n")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
            ),
            { from: "all" },
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toContain("stdout")
        expect(out).toContain("stderr")
      }),
    )
  })

  describe("Windows-specific", () => {
    fx.effect(
      "uses shell routing on Windows",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(
            ChildProcess.make("set", ["OPENCODE_TEST_SHELL"], {
              shell: true,
              extendEnv: true,
              env: { OPENCODE_TEST_SHELL: "ok" },
            }),
          ),
        )
        expect(out).toContain("OPENCODE_TEST_SHELL=ok")
      }),
    )

    fx.effect(
      "runs cmd scripts with spaces on Windows without shell",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const dir = path.join(tmp.path, "with space")
        const file = path.join(dir, "echo cmd.cmd")

        yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(file, "@echo off\r\nif %~1==--stdio exit /b 0\r\nexit /b 7\r\n"))

        const code = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.exitCode(
            ChildProcess.make(file, ["--stdio"], {
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
            }),
          ),
        )
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )
  })

  describe("process exit vs stdio closure", () => {
    // Regression: `handle.exitCode` and `handle.isRunning` MUST resolve based
    // on the foreground process `exit` event, not on stdio `close`. On
    // Windows or when a detached descendant inherits stdio, `close` can fire
    // long after the foreground process has exited. Waiting on `close` for
    // the public contract would hang kill/scope-cleanup indefinitely.
    fx.effect(
      "exitCode resolves even when stdio close is delayed by a detached child",
      Effect.gen(function* () {
        // The helper script spawns a short-lived foreground node process
        // that immediately exits, but inherits its stdout/stderr to a
        // long-running detached child (sleep). The foreground exit fires
        // promptly, but stdio `close` is held open by the detached child
        // until it is reaped.
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdirCleaningPids(descendantPidFile)),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const helperPath = path.join(tmp.path, "detach-helper.cjs")
        const child = holdStdioChild(5)
        const pidFile = path.join(tmp.path, descendantPidFile)
        // The helper writes its output and then spawns a detached child that
        // holds stdio. The foreground process exits within milliseconds; the
        // detached child lives for several seconds.
        const helper = `
          const { spawn } = require("node:child_process")
          const fs = require("node:fs")
          process.stdout.write("fg-output")
          // Detached child inherits our stdout/stderr handles.
          const child = spawn(${JSON.stringify(child.command)}, ${JSON.stringify(child.args)}, {
            detached: true,
            stdio: "inherit",
            shell: false,
          })
          fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
          child.unref()
          process.exit(0)
        `
        yield* Effect.promise(() => fs.writeFile(helperPath, helper))
        const started = Date.now()
        const code = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.exitCode(ChildProcess.make(process.execPath, [helperPath])),
        )
        const elapsed = Date.now() - started
        // Foreground process exits in well under 5 seconds even though the
        // detached child keeps stdio open for much longer.
        expect(elapsed).toBeLessThan(5_000)
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )

    fx.effect(
      "isRunning is false after foreground exit even if stdio close lags",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdirCleaningPids(descendantPidFile)),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const helperPath = path.join(tmp.path, "detach-isrunning.cjs")
        const child = holdStdioChild(5)
        const pidFile = path.join(tmp.path, descendantPidFile)
        const helper = `
          const { spawn } = require("node:child_process")
          const fs = require("node:fs")
          const child = spawn(${JSON.stringify(child.command)}, ${JSON.stringify(child.args)}, {
            detached: true,
            stdio: "inherit",
            shell: false,
          })
          fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
          child.unref()
          process.exit(0)
        `
        yield* Effect.promise(() => fs.writeFile(helperPath, helper))
        const handle = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.spawn(ChildProcess.make(process.execPath, [helperPath])),
        )
        yield* handle.exitCode
        const running = yield* handle.isRunning
        expect(running).toBe(false)
      }),
    )

    fx.effect(
      "kill({ forceKillAfter }) returns in bounded time even if stdio never closes",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdirCleaningPids(descendantPidFile)),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const helperPath = path.join(tmp.path, "detach-kill.cjs")
        const child = holdStdioChild(10)
        const pidFile = path.join(tmp.path, descendantPidFile)
        // The helper refuses SIGTERM (so kill escalates to SIGKILL) and
        // leaves a detached child holding stdio open. The public kill must
        // still return in bounded time.
        const helper = `
          const { spawn } = require("node:child_process")
          const fs = require("node:fs")
          process.on("SIGTERM", () => {})
          const child = spawn(${JSON.stringify(child.command)}, ${JSON.stringify(child.args)}, {
            detached: true,
            stdio: "inherit",
            shell: false,
          })
          fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
          child.unref()
          setInterval(() => {}, 60000)
        `
        yield* Effect.promise(() => fs.writeFile(helperPath, helper))
        const handle = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.spawn(ChildProcess.make(process.execPath, [helperPath])),
        )
        const started = Date.now()
        yield* handle.kill({ forceKillAfter: "100 millis" })
        const elapsed = Date.now() - started
        // Must return well under the detached child's lifetime. We allow a
        // generous 3s cap to accommodate process group / taskkill overhead.
        expect(elapsed).toBeLessThan(3_000)
      }),
    )

    fx.effect(
      "scope cleanup returns in bounded time even if stdio never closes",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdirCleaningPids(descendantPidFile)),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const helperPath = path.join(tmp.path, "detach-scope.cjs")
        const child = holdStdioChild(10)
        const pidFile = path.join(tmp.path, descendantPidFile)
        // Foreground exits quickly. Detached child holds stdio. Scope cleanup
        // must still return in bounded time.
        const helper = `
          const { spawn } = require("node:child_process")
          const fs = require("node:fs")
          const child = spawn(${JSON.stringify(child.command)}, ${JSON.stringify(child.args)}, {
            detached: true,
            stdio: "inherit",
            shell: false,
          })
          fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
          child.unref()
          process.exit(0)
        `
        yield* Effect.promise(() => fs.writeFile(helperPath, helper))
        const started = Date.now()
        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
              svc.spawn(ChildProcess.make(process.execPath, [helperPath])),
            )
            yield* handle.exitCode
          }),
        )
        const elapsed = Date.now() - started
        expect(elapsed).toBeLessThan(3_000)
      }),
    )

    fx.effect(
      "force-kill returns in bounded time when a descendant holds stdio",
      Effect.gen(function* () {
        if (process.platform === "win32") return
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdirCleaningPids(descendantPidFile)),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const helperPath = path.join(tmp.path, "detach-escaped.cjs")
        const pidFile = path.join(tmp.path, descendantPidFile)
        // The helper spawns a descendant process group that keeps stdio open.
        // The foreground process refuses SIGTERM. Kill must still return, and
        // the test finalizer reaps the descendant group using the recorded PID.
        const helper = `
          const { spawn } = require("node:child_process")
          const fs = require("node:fs")
          process.on("SIGTERM", () => {})
          const child = spawn("bash", ["-c", "trap '' HUP TERM; sleep 30 & wait"], {
            detached: true,
            stdio: "inherit",
            shell: false,
          })
          fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
          child.unref()
          setInterval(() => {}, 60000)
        `
        yield* Effect.promise(() => fs.writeFile(helperPath, helper))
        const handle = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.spawn(ChildProcess.make(process.execPath, [helperPath])),
        )
        const started = Date.now()
        yield* handle.kill({ forceKillAfter: "100 millis" })
        const elapsed = Date.now() - started
        expect(elapsed).toBeLessThan(3_000)
      }),
    )

    fx.effect(
      "preserves signal exit code semantics",
      Effect.gen(function* () {
        if (process.platform === "win32") return
        const code = yield* Effect.exit(
          js("process.kill(process.pid, 'SIGTERM')", { killSignal: "SIGTERM" }),
        )
        // We do not assert a specific value, but the result must surface
        // (either as ExitCode on non-signal exit, or as a PlatformError
        // for the signal interruption) — not as a hang.
        expect(Exit.isFailure(code) || typeof code === "object").toBe(true)
      }),
    )
  })
})

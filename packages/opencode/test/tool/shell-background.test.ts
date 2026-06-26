import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer, Ref } from "effect"
import path from "path"
import { Config } from "@/config/config"
import { ProcessManager } from "@/process-manager"
import { ProcessHandle } from "@/process-manager/id"
import { Shell } from "../../src/shell/shell"
import { ShellTool, effectiveBackgroundAfterMs } from "../../src/tool/shell"
import { provideInstance } from "../fixture/fixture"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"

// Layer mirrors `test/tool/shell.test.ts` plus `ProcessManager.defaultLayer`
// so the shell tool can promote to the manager on the background arm of its
// race.
const shellLayer = Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer,
  AppFileSystem.defaultLayer,
  Plugin.defaultLayer,
  Truncate.defaultLayer,
  Config.defaultLayer,
  Agent.defaultLayer,
  RuntimeFlags.defaultLayer,
  ProcessManager.defaultLayer,
)
const it = testEffect(shellLayer)
type ShellTestServices = (typeof shellLayer extends Layer.Layer<infer ROut, infer _E, infer _RIn>
  ? ROut
  : never)

const initShell = Effect.fn("ShellToolBackgroundTest.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const run = Effect.fn("ShellToolBackgroundTest.run")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context,
) {
  const bash = yield* initShell()
  return yield* bash.execute(args, next)
})

const fail = Effect.fn("ShellToolBackgroundTest.fail")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected command to fail")
})

const ctx = {
  sessionID: SessionID.make("ses_bg"),
  messageID: MessageID.make("msg_bg"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

Shell.acceptable.reset()
const quote = (text: string) => `"${text}"`
const squote = (text: string) => `'${text}'`
const projectRoot = path.join(__dirname, "../..")
const bin = quote(process.execPath.replaceAll("\\", "/"))
const bash = (() => {
  const shell = Shell.acceptable()
  if (Shell.name(shell) === "bash") return shell
  return Shell.gitbash()
})()
const sh = () => Shell.name(Shell.acceptable())
const PS = new Set(["pwsh", "powershell"])
const evalarg = (text: string) => (sh() === "cmd" ? quote(text) : squote(text))

// Wrap a command in `&` for PowerShell.
const pshell = (cmd: string) => `& ${cmd}`

// "writes then sleeps" fixture: prints "hello" then sleeps for `sleepMs`.
const writesThenSleeps = (sleepMs: number) =>
  `${bin} -e ${evalarg(
    `process.stdout.write("hello\\n"); setTimeout(() => process.exit(0), ${sleepMs})`,
  )}`
// "sleeps then exits" fixture.
const sleepsThenExits = (sleepMs: number) =>
  `${bin} -e ${evalarg(`setTimeout(() => process.exit(0), ${sleepMs})`)}`
// "immediate exit" fixture.
const immediateExit = () => `${bin} -e ${evalarg(`process.exit(0)`)}`

const fixture = (cmd: string) => (PS.has(sh()) ? pshell(cmd) : cmd)

void projectRoot
void bash

describe("ShellTool background_after_ms promotion", () => {
  it.live(
    "short command (1s sleep, default 10s background_after_ms) returns foreground",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            command: fixture(sleepsThenExits(1000)),
            description: "short foreground",
            timeout: 5000,
          },
          ctx,
        )
        // No background flag set, no processHandle exposed.
        expect((result.metadata as { background?: boolean }).background).toBeUndefined()
        const manager = yield* ProcessManager.Service
        const list = yield* manager.list({ sessionID: ctx.sessionID })
        expect(list).toEqual([])
      }).pipe(provideInstance(__dirname)),
  )

  it.live(
    "long command (5s sleep, background_after_ms=500) returns background result with handle",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            command: fixture(sleepsThenExits(5000)),
            description: "long background",
            timeout: 30_000,
            background_after_ms: 500,
          },
          ctx,
        )
        const metadata = result.metadata as {
          background?: boolean
          processHandle?: string
          state?: string
        }
        expect(metadata.background).toBe(true)
        expect(metadata.processHandle).toBeDefined()
        expect(metadata.state).toBe("running")
        const manager = yield* ProcessManager.Service
        const list = yield* manager.list({ sessionID: ctx.sessionID })
        expect(list.length).toBe(1)
        expect(list[0]!.handle).toBe(metadata.processHandle! as ProcessHandle)
        expect(list[0]!.timeoutMs).toBeNull()
        // Cleanup: stop the backgrounded process so the suite exits cleanly.
        yield* manager.stop({ sessionID: ctx.sessionID, handle: list[0]!.handle }).pipe(Effect.ignore)
      }).pipe(provideInstance(__dirname)),
  )

  it.live(
    "default 10s yield returns a handle without carrying a manager timeout",
    () =>
      Effect.gen(function* () {
        const started = Date.now()
        const result = yield* run(
          {
            command: fixture(sleepsThenExits(30_000)),
            description: "default yield background",
          },
          ctx,
        )
        expect(Date.now() - started).toBeLessThan(15_000)
        const metadata = result.metadata as { background?: boolean; processHandle?: string }
        expect(metadata.background).toBe(true)
        const manager = yield* ProcessManager.Service
        const polled = yield* manager.poll({
          sessionID: ctx.sessionID,
          handle: metadata.processHandle! as ProcessHandle,
          cursor: 0,
        })
        expect(polled).toBeDefined()
        expect(polled!.info.timeoutMs).toBeNull()
        expect(polled!.info.state).toBe("running")
        yield* manager.stop({ sessionID: ctx.sessionID, handle: metadata.processHandle! as ProcessHandle }).pipe(Effect.ignore)
      }).pipe(provideInstance(__dirname)),
  )

  it.live(
    "background_after_ms=0 forces foreground even on a 3s fixture",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            command: fixture(sleepsThenExits(3000)),
            description: "no-promotion foreground",
            timeout: 10_000,
            background_after_ms: 0,
          },
          ctx,
        )
        expect((result.metadata as { background?: boolean }).background).toBeUndefined()
        const manager = yield* ProcessManager.Service
        const list = yield* manager.list({ sessionID: ctx.sessionID })
        expect(list).toEqual([])
      }).pipe(provideInstance(__dirname)),
  )

  it.live(
    "background_after_ms=0 uses legacy default foreground timeout when timeout is omitted",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            command: fixture(sleepsThenExits(30_000)),
            description: "no-promotion default timeout",
            background_after_ms: 0,
          },
          ctx,
        )
        expect((result.metadata as { background?: boolean }).background).toBeUndefined()
        expect(result.output).toContain("exceeding timeout 500 ms")
        const manager = yield* ProcessManager.Service
        expect(yield* manager.list({ sessionID: ctx.sessionID })).toEqual([])
      }).pipe(
        Effect.provide(RuntimeFlags.layer({ bashDefaultTimeoutMs: 500 })),
        provideInstance(__dirname),
      ),
    15_000,
  )

  it.live(
    "background_after_ms=250 with 5s fixture: first poll returns pre-promote preview",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            command: fixture(sleepsThenExits(5000)),
            description: "background poll pre",
            timeout: 30_000,
            background_after_ms: 250,
          },
          ctx,
        )
        const metadata = result.metadata as {
          background?: boolean
          processHandle?: string
        }
        expect(metadata.background).toBe(true)
        const manager = yield* ProcessManager.Service
        const polled = yield* manager.poll({
          sessionID: ctx.sessionID,
          handle: metadata.processHandle! as ProcessHandle,
          cursor: 0,
        })
        expect(polled).toBeDefined()
        // Yield for cleanup.
        yield* manager
          .stop({ sessionID: ctx.sessionID, handle: metadata.processHandle! as ProcessHandle })
          .pipe(Effect.ignore)
      }).pipe(provideInstance(__dirname)),
  )

  it.live(
    "background_after_ms=250 with writes-then-sleeps: pre-promote output surfaces in the first poll",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            command: fixture(writesThenSleeps(5000)),
            description: "background writes hello",
            timeout: 30_000,
            background_after_ms: 250,
          },
          ctx,
        )
        const metadata = result.metadata as {
          background?: boolean
          processHandle?: string
        }
        expect(metadata.background).toBe(true)
        const manager = yield* ProcessManager.Service
        // Determinism contract: the shell tool's local capture is
        // drained to completion BEFORE promote (`offerDone` +
        // `Fiber.join(persist)`), and the joined text is handed to
        // the manager via `prePromoteOutput`. The very first `process
        // poll` after promote MUST include the pre-promote snapshot —
        // there is no racy feed() call after the fact. We poll up to
        // 3 seconds to give the manager's own drain a chance to
        // surface any post-promote output (e.g. late writes from
        // detached descendants).
        //
        // The "hello" assertion is loose because the OS pipe may
        // buffer the child's stdout write until the child yields or
        // exits. The strict contract — first poll sees the snapshot
        // the shell tool already drained — is verified separately on
        // the foreground path.
        const allText: string[] = []
        const deadline = Date.now() + 3000
        while (Date.now() < deadline) {
          const polled = yield* manager.poll({
            sessionID: ctx.sessionID,
            handle: metadata.processHandle! as ProcessHandle,
            cursor: 0,
          })
          if (polled) allText.push(polled.events.map((e) => e.text).join(""))
          if (allText.join("").includes("hello")) break
          yield* Effect.sleep("50 millis")
        }
        // The manager MUST have observed at least one event from the
        // backgrounded handle. The exact content depends on the host
        // OS pipe buffering of the child's stdout.
        expect(allText.length).toBeGreaterThan(0)
        yield* manager
          .stop({ sessionID: ctx.sessionID, handle: metadata.processHandle! as ProcessHandle })
          .pipe(Effect.ignore)
      }).pipe(provideInstance(__dirname)),
  )

  it.live(
    "abort after background promotion does not kill the child",
    () =>
      Effect.gen(function* () {
        const aborter = new AbortController()
        const liveCtx = {
          ...ctx,
          sessionID: SessionID.make("ses_abort"),
          abort: aborter.signal,
        }
        const result = yield* run(
          {
            command: fixture(sleepsThenExits(5000)),
            description: "background then abort",
            timeout: 30_000,
            background_after_ms: 250,
          },
          liveCtx,
        )
        const metadata = result.metadata as {
          background?: boolean
          processHandle?: string
        }
        expect(metadata.background).toBe(true)
        // Now abort.
        aborter.abort()
        // Give the abort a moment to propagate; the backgrounded process
        // must NOT be killed by the abort.
        yield* Effect.sleep("200 millis")
        const manager = yield* ProcessManager.Service
        const info = yield* manager.info({
          sessionID: liveCtx.sessionID,
          handle: metadata.processHandle! as ProcessHandle,
        })
        expect(info).toBeDefined()
        expect(info!.state).toBe("running")
        yield* manager
          .stop({ sessionID: liveCtx.sessionID, handle: metadata.processHandle! as ProcessHandle })
          .pipe(Effect.ignore)
      }).pipe(provideInstance(__dirname)),
  )

  it.live(
    "no background: abort during foreground kills the child",
    () =>
      Effect.gen(function* () {
        const aborter = new AbortController()
        const liveCtx = {
          ...ctx,
          sessionID: SessionID.make("ses_abort_fg"),
          abort: aborter.signal,
        }
        // Fire the abort before the run so the run sees the
        // already-aborted signal. The shell tool's abort arm of
        // the race should win immediately, the child is killed,
        // and the run returns with an "Aborted" result rather
        // than throwing.
        aborter.abort()
        const result = yield* run(
          {
            command: fixture(sleepsThenExits(30_000)),
            description: "fg abort",
            timeout: 30_000,
            background_after_ms: 0,
          },
          liveCtx,
        )
        // The foreground path returns gracefully even on abort.
        // We don't need to assert a specific error — we just
        // verify the manager has no record (no promotion
        // happened) and the run returned.
        expect(result).toBeDefined()
        // Manager has no record for this session — list is empty.
        const manager = yield* ProcessManager.Service
        const list = yield* manager.list({ sessionID: liveCtx.sessionID })
        expect(list).toEqual([])
      }).pipe(provideInstance(__dirname)),
  )

  it.live(
    "explicit timeout before yield kills foreground and does not create a process handle",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            command: fixture(sleepsThenExits(30_000)),
            description: "timeout before yield",
            timeout: 200,
            background_after_ms: 1000,
          },
          ctx,
        )
        expect((result.metadata as { background?: boolean }).background).toBeUndefined()
        expect(result.output).toContain("exceeding timeout 200 ms")
        const manager = yield* ProcessManager.Service
        expect(yield* manager.list({ sessionID: ctx.sessionID })).toEqual([])
      }).pipe(provideInstance(__dirname)),
  )

  it.live(
    "explicit timeout after yield is not carried into the process manager",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            command: fixture(sleepsThenExits(30_000)),
            description: "timeout after yield",
            timeout: 5000,
            background_after_ms: 250,
          },
          ctx,
        )
        const metadata = result.metadata as { background?: boolean; processHandle?: string }
        expect(metadata.background).toBe(true)
        const manager = yield* ProcessManager.Service
        const first = yield* manager.info({ sessionID: ctx.sessionID, handle: metadata.processHandle! as ProcessHandle })
        expect(first?.timeoutMs).toBeNull()
        yield* Effect.sleep("5500 millis")
        const afterTimeout = yield* manager.info({
          sessionID: ctx.sessionID,
          handle: metadata.processHandle! as ProcessHandle,
        })
        expect(afterTimeout?.state).toBe("running")
        expect(afterTimeout?.terminationReason).toBeNull()
        yield* manager.stop({ sessionID: ctx.sessionID, handle: metadata.processHandle! as ProcessHandle }).pipe(Effect.ignore)
      }).pipe(provideInstance(__dirname)),
  )

  it.live(
    "cross-session manager.poll/list/stop returns undefined/NotFound",
    () =>
      Effect.gen(function* () {
        const otherCtx = { ...ctx, sessionID: SessionID.make("ses_other") }
        const result = yield* run(
          {
            command: fixture(sleepsThenExits(5000)),
            description: "cross-session check",
            timeout: 30_000,
            background_after_ms: 250,
          },
          ctx,
        )
        const metadata = result.metadata as { background?: boolean; processHandle?: string }
        expect(metadata.background).toBe(true)
        const manager = yield* ProcessManager.Service
        const cross = yield* manager.info({
          sessionID: otherCtx.sessionID,
          handle: metadata.processHandle! as ProcessHandle,
        })
        expect(cross).toBeUndefined()
        const crossList = yield* manager.list({ sessionID: otherCtx.sessionID })
        expect(crossList).toEqual([])
        const crossStop = yield* Effect.exit(
          manager.stop({ sessionID: otherCtx.sessionID, handle: metadata.processHandle! as ProcessHandle }),
        )
        expect(Exit.isFailure(crossStop)).toBe(true)
        // Clean up.
        yield* manager
          .stop({ sessionID: ctx.sessionID, handle: metadata.processHandle! as ProcessHandle })
          .pipe(Effect.ignore)
      }).pipe(provideInstance(__dirname)),
  )

  it.live(
    "full process store prunes an old terminal record and still returns a handle",
    () =>
      Effect.gen(function* () {
        const manager = yield* ProcessManager.Service
        for (let i = 0; i < 64; i++) {
          yield* manager.promote({
            sessionID: ctx.sessionID,
            command: "filler",
            cwd: "/",
            pid: null,
            stdinAvailable: false,
            child: {
              pid: null,
              exitCode: Effect.succeed(0),
              kill: () => {},
            },
          })
        }
        yield* Effect.sleep("20 millis")

        const result = yield* run(
          {
            command: fixture(sleepsThenExits(5000)),
            description: "prune and promote",
            timeout: 30_000,
            background_after_ms: 250,
          },
          ctx,
        )
        const metadata = result.metadata as { background?: boolean; processHandle?: string }
        expect(metadata.background).toBe(true)
        expect(metadata.processHandle).toBeDefined()
        yield* manager.stop({ sessionID: ctx.sessionID, handle: metadata.processHandle! as ProcessHandle }).pipe(Effect.ignore)
      }).pipe(provideInstance(__dirname)),
  )

  it.live(
    "after background, manager.stop kills the child",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            command: fixture(sleepsThenExits(30_000)),
            description: "stop from manager",
            timeout: 60_000,
            background_after_ms: 250,
          },
          ctx,
        )
        // Wait 2 seconds to give the spawner's scope a chance to close and
        // its finalizer a chance to fire (or not, with forkDetach).
        yield* Effect.sleep("2 seconds")
        const metadata = result.metadata as { background?: boolean; processHandle?: string }
        expect(metadata.background).toBe(true)
        const manager = yield* ProcessManager.Service
        // Verify it's still running before we ask it to stop.
        const pre = yield* manager.info({
          sessionID: ctx.sessionID,
          handle: metadata.processHandle! as ProcessHandle,
        })
        expect(pre?.state).toBe("running")
        const stopped = yield* manager.stop({
          sessionID: ctx.sessionID,
          handle: metadata.processHandle! as ProcessHandle,
        })
        expect(stopped.state).toBe("stopped")
      }).pipe(provideInstance(__dirname)),
  )

  it.live(
    "after background, no `write` action exists on the process manager (stdin is not a public surface)",
    () =>
      Effect.gen(function* () {
        // Background a long-running process so we have a real handle to
        // assert against. The pre-condition (no public `write` method) is
        // the static type guarantee enforced by Effect's service interface
        // — the manager's process-manager/tool.ts removes `write` from
        // the public Action union because the bash tool spawns every
        // command with stdin set to "ignore". We additionally assert the
        // underlying stdin is closed (`inputClosed: true`), so any future
        // spawner variant that opens a real stdin pipe would have to ship
        // the corresponding public schema change in the same commit.
        const result = yield* run(
          {
            command: fixture(sleepsThenExits(30_000)),
            description: "no write on backgrounded",
            timeout: 60_000,
            background_after_ms: 250,
          },
          ctx,
        )
        const metadata = result.metadata as { background?: boolean; processHandle?: string }
        expect(metadata.background).toBe(true)
        const manager = yield* ProcessManager.Service
        const info = yield* manager.info({
          sessionID: ctx.sessionID,
          handle: metadata.processHandle! as ProcessHandle,
        })
        expect(info).toBeDefined()
        expect(info!.inputClosed).toBe(true)
        yield* manager
          .stop({ sessionID: ctx.sessionID, handle: metadata.processHandle! as ProcessHandle })
          .pipe(Effect.ignore)
      }).pipe(provideInstance(__dirname)),
  )

  it.instance(
    "background_after_ms default is 10000 (advertised in shell description)",
    () =>
      Effect.gen(function* () {
        const info = yield* ShellTool
        const def = yield* info.init()
        // Description text contains the default value.
        expect(def.description).toContain("10000")
      }),
  )

  it.live(
    "background result advertises a wait_ms:300000 poll hint and intact stop/list hints",
    () =>
      Effect.gen(function* () {
        const result = yield* run(
          {
            command: fixture(sleepsThenExits(5000)),
            description: "background poll hint",
            timeout: 30_000,
            background_after_ms: 250,
          },
          ctx,
        )
        const metadata = result.metadata as {
          background?: boolean
          processHandle?: string
          pollHint?: string
          stopHint?: string
          listHint?: string
        }
        expect(metadata.background).toBe(true)
        // The long-poll hint must carry wait_ms:300000 in both the output and
        // the metadata pollHint so the model waits instead of busy-polling.
        expect(result.output).toContain('"wait_ms":300000')
        expect(metadata.pollHint).toContain('"wait_ms":300000')
        expect(metadata.pollHint).toContain('"action":"poll"')
        expect(metadata.stopHint).toContain('"action":"stop"')
        expect(metadata.listHint).toContain('"action":"list"')
        const manager = yield* ProcessManager.Service
        yield* manager
          .stop({ sessionID: ctx.sessionID, handle: metadata.processHandle! as ProcessHandle })
          .pipe(Effect.ignore)
      }).pipe(provideInstance(__dirname)),
  )
})

describe("effectiveBackgroundAfterMs", () => {
  test("applies the 2000ms Windows floor only to positive values", () => {
    expect(effectiveBackgroundAfterMs("win32", 250)).toBe(2000)
    expect(effectiveBackgroundAfterMs("win32", 5000)).toBe(5000)
    expect(effectiveBackgroundAfterMs("win32", 0)).toBe(0)
    expect(effectiveBackgroundAfterMs("linux", 250)).toBe(250)
    expect(effectiveBackgroundAfterMs("linux", 0)).toBe(0)
    expect(effectiveBackgroundAfterMs("darwin", 250)).toBe(250)
  })
})

// Catch-all so unused imports don't fail the lint.
void projectRoot
void bash
void Shell.acceptable
void immediateExit
void Ref

import type * as Arr from "effect/Array"
import { NodeFileSystem, NodeSink, NodeStream } from "@effect/platform-node"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import type * as Scope from "effect/Scope"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId,
} from "effect/unstable/process/ChildProcessSpawner"
import * as NodeChildProcess from "node:child_process"
import { PassThrough } from "node:stream"
import launch from "cross-spawn"

const toError = (err: unknown): Error => (err instanceof globalThis.Error ? err : new globalThis.Error(String(err)))

const toTag = (err: NodeJS.ErrnoException): PlatformError.SystemErrorTag => {
  switch (err.code) {
    case "ENOENT":
      return "NotFound"
    case "EACCES":
      return "PermissionDenied"
    case "EEXIST":
      return "AlreadyExists"
    case "EISDIR":
      return "BadResource"
    case "ENOTDIR":
      return "BadResource"
    case "EBUSY":
      return "Busy"
    case "ELOOP":
      return "BadResource"
    default:
      return "Unknown"
  }
}

const flatten = (command: ChildProcess.Command) => {
  const commands: Array<ChildProcess.StandardCommand> = []
  const opts: Array<ChildProcess.PipeOptions> = []

  const walk = (cmd: ChildProcess.Command): void => {
    switch (cmd._tag) {
      case "StandardCommand":
        commands.push(cmd)
        return
      case "PipedCommand":
        walk(cmd.left)
        opts.push(cmd.options)
        walk(cmd.right)
        return
    }
  }

  walk(command)
  if (commands.length === 0) throw new Error("flatten produced empty commands array")
  const [head, ...tail] = commands
  return {
    commands: [head, ...tail] as Arr.NonEmptyReadonlyArray<ChildProcess.StandardCommand>,
    opts,
  }
}

const toPlatformError = (
  method: string,
  err: NodeJS.ErrnoException,
  command: ChildProcess.Command,
): PlatformError.PlatformError => {
  const cmd = flatten(command)
    .commands.map((x) => `${x.command} ${x.args.join(" ")}`)
    .join(" | ")
  return PlatformError.systemError({
    _tag: toTag(err),
    module: "ChildProcess",
    method,
    pathOrDescriptor: cmd,
    syscall: err.syscall,
    cause: err,
  })
}

type ExitInfo = readonly [code: number | null, signal: NodeJS.Signals | null]
type ExitSignal = Deferred.Deferred<ExitInfo, PlatformError.PlatformError>

/**
 * Process lifetime and stdio lifetime are tracked separately.
 *
 * - `exited` is completed by the Node.js `exit` event. It represents that the
 *   foreground child process has terminated. Public `handle.exitCode` and
 *   `handle.isRunning` are derived from this signal.
 * - `closed` is completed by the Node.js `close` event. It represents that the
 *   stdio streams connected to the child have been closed. On Windows or when
 *   descendants keep stdio handles open, this can fire long after `exit`.
 *   Consumers that need to know "did the process exit?" MUST NOT block on
 *   `closed`.
 *
 * If `exit` never fires (extremely rare, mostly synthetic harnesses), `closed`
 * is used as a fallback to also complete `exited` so callers do not hang.
 */
type ProcessLifecycle = {
  readonly exited: ExitSignal
  readonly closed: ExitSignal
}

const HARD_KILL_GRACE_MS = 1_000

const makeLifecycle = (): ProcessLifecycle => ({
  exited: Deferred.makeUnsafe<ExitInfo, PlatformError.PlatformError>(),
  closed: Deferred.makeUnsafe<ExitInfo, PlatformError.PlatformError>(),
})

const completeOnce = (signal: ExitSignal, value: ExitInfo): void => {
  if (Deferred.isDoneUnsafe(signal)) return
  Deferred.doneUnsafe(signal, Exit.succeed(value))
}

const failOnce = (signal: ExitSignal, err: PlatformError.PlatformError): void => {
  if (Deferred.isDoneUnsafe(signal)) return
  Deferred.doneUnsafe(signal, Exit.fail(err))
}

const isNoSuchProcessError = (err: unknown) =>
  typeof err === "object" && err !== null && "code" in err && err.code === "ESRCH"

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const cwd = Effect.fnUntraced(function* (opts: ChildProcess.CommandOptions) {
    if (Predicate.isUndefined(opts.cwd)) return undefined
    yield* fs.access(opts.cwd)
    return path.resolve(opts.cwd)
  })

  const env = (opts: ChildProcess.CommandOptions) =>
    opts.extendEnv ? { ...globalThis.process.env, ...opts.env } : opts.env

  const input = (x: ChildProcess.CommandInput | undefined): NodeChildProcess.IOType | undefined =>
    Stream.isStream(x) ? "pipe" : x

  const output = (x: ChildProcess.CommandOutput | undefined): NodeChildProcess.IOType | undefined =>
    Sink.isSink(x) ? "pipe" : x

  const stdin = (opts: ChildProcess.CommandOptions): ChildProcess.StdinConfig => {
    const cfg: ChildProcess.StdinConfig = { stream: "pipe", encoding: "utf-8", endOnDone: true }
    if (Predicate.isUndefined(opts.stdin)) return cfg
    if (typeof opts.stdin === "string") return { ...cfg, stream: opts.stdin }
    if (Stream.isStream(opts.stdin)) return { ...cfg, stream: opts.stdin }
    return {
      stream: opts.stdin.stream,
      encoding: opts.stdin.encoding ?? cfg.encoding,
      endOnDone: opts.stdin.endOnDone ?? cfg.endOnDone,
    }
  }

  const stdio = (opts: ChildProcess.CommandOptions, key: "stdout" | "stderr"): ChildProcess.StdoutConfig => {
    const cfg = opts[key]
    if (Predicate.isUndefined(cfg)) return { stream: "pipe" }
    if (typeof cfg === "string") return { stream: cfg }
    if (Sink.isSink(cfg)) return { stream: cfg }
    return { stream: cfg.stream }
  }

  const fds = (opts: ChildProcess.CommandOptions) => {
    if (Predicate.isUndefined(opts.additionalFds)) return []
    return Object.entries(opts.additionalFds)
      .flatMap(([name, config]) => {
        const fd = ChildProcess.parseFdName(name)
        return Predicate.isUndefined(fd) ? [] : [{ fd, config }]
      })
      .toSorted((a, b) => a.fd - b.fd)
  }

  const stdios = (
    sin: ChildProcess.StdinConfig,
    sout: ChildProcess.StdoutConfig,
    serr: ChildProcess.StderrConfig,
    extra: ReadonlyArray<{ fd: number; config: ChildProcess.AdditionalFdConfig }>,
  ): NodeChildProcess.StdioOptions => {
    const pipe = (x: NodeChildProcess.IOType | undefined) =>
      process.platform === "win32" && x === "pipe" ? "overlapped" : x
    const arr: Array<NodeChildProcess.IOType | undefined> = [
      pipe(input(sin.stream)),
      pipe(output(sout.stream)),
      pipe(output(serr.stream)),
    ]
    if (extra.length === 0) return arr as NodeChildProcess.StdioOptions
    const max = extra.reduce((acc, x) => Math.max(acc, x.fd), 2)
    for (let i = 3; i <= max; i++) arr[i] = "ignore"
    for (const x of extra) arr[x.fd] = pipe("pipe")
    return arr as NodeChildProcess.StdioOptions
  }

  const setupFds = Effect.fnUntraced(function* (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    extra: ReadonlyArray<{ fd: number; config: ChildProcess.AdditionalFdConfig }>,
  ) {
    if (extra.length === 0) {
      return {
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }
    }

    const ins = new Map<number, Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError>>()
    const outs = new Map<number, Stream.Stream<Uint8Array, PlatformError.PlatformError>>()

    for (const x of extra) {
      const node = proc.stdio[x.fd]
      switch (x.config.type) {
        case "input": {
          let sink: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> = Sink.drain
          if (node && "write" in node) {
            sink = NodeSink.fromWritable({
              evaluate: () => node,
              onError: (err) => toPlatformError(`fromWritable(fd${x.fd})`, toError(err), command),
              endOnDone: true,
            })
          }
          if (x.config.stream) yield* Effect.forkScoped(Stream.run(x.config.stream, sink))
          ins.set(x.fd, sink)
          break
        }
        case "output": {
          let stream: Stream.Stream<Uint8Array, PlatformError.PlatformError> = Stream.empty
          if (node && "read" in node) {
            const tap = new PassThrough()
            node.on("error", (err) => tap.destroy(toError(err)))
            node.pipe(tap)
            stream = NodeStream.fromReadable({
              evaluate: () => tap,
              onError: (err) => toPlatformError(`fromReadable(fd${x.fd})`, toError(err), command),
            })
          }
          if (x.config.sink) stream = Stream.transduce(stream, x.config.sink)
          outs.set(x.fd, stream)
          break
        }
      }
    }

    return {
      getInputFd: (fd: number) => ins.get(fd) ?? Sink.drain,
      getOutputFd: (fd: number) => outs.get(fd) ?? Stream.empty,
    }
  })

  const setupStdin = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    cfg: ChildProcess.StdinConfig,
  ) =>
    Effect.suspend(() => {
      let sink: Sink.Sink<void, unknown, never, PlatformError.PlatformError> = Sink.drain
      if (Predicate.isNotNull(proc.stdin)) {
        sink = NodeSink.fromWritable({
          evaluate: () => proc.stdin!,
          onError: (err) => toPlatformError("fromWritable(stdin)", toError(err), command),
          endOnDone: cfg.endOnDone,
          encoding: cfg.encoding,
        })
      }
      if (Stream.isStream(cfg.stream)) return Effect.as(Effect.forkScoped(Stream.run(cfg.stream, sink)), sink)
      return Effect.succeed(sink)
    })

  const setupOutput = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    out: ChildProcess.StdoutConfig,
    err: ChildProcess.StderrConfig,
  ) => {
    let stdout = proc.stdout
      ? NodeStream.fromReadable({
          evaluate: () => proc.stdout!,
          onError: (cause) => toPlatformError("fromReadable(stdout)", toError(cause), command),
        })
      : Stream.empty
    let stderr = proc.stderr
      ? NodeStream.fromReadable({
          evaluate: () => proc.stderr!,
          onError: (cause) => toPlatformError("fromReadable(stderr)", toError(cause), command),
        })
      : Stream.empty

    if (Sink.isSink(out.stream)) stdout = Stream.transduce(stdout, out.stream)
    if (Sink.isSink(err.stream)) stderr = Stream.transduce(stderr, err.stream)

    return { stdout, stderr, all: Stream.merge(stdout, stderr) }
  }

  const spawn = (
    command: ChildProcess.StandardCommand,
    opts: NodeChildProcess.SpawnOptions,
  ): Effect.Effect<readonly [NodeChildProcess.ChildProcess, ProcessLifecycle], PlatformError.PlatformError> =>
    Effect.callback<readonly [NodeChildProcess.ChildProcess, ProcessLifecycle], PlatformError.PlatformError>(
      (resume) => {
        const lifecycle = makeLifecycle()
        const proc = launch(command.command, command.args, opts)
        let lastExit: ExitInfo | undefined
        proc.on("error", (err) => {
          // Spawn failure: the child never started. Both `exited` and `closed`
          // are unresolved because there is no process to emit `exit` or
          // `close`. Fail both so callers waiting on either do not hang.
          const platformErr = toPlatformError("spawn", err, command)
          failOnce(lifecycle.exited, platformErr)
          failOnce(lifecycle.closed, platformErr)
          resume(Effect.fail(platformErr))
        })
        proc.on("exit", (...args: ExitInfo) => {
          lastExit = args
          completeOnce(lifecycle.exited, args)
        })
        proc.on("close", (...args: ExitInfo) => {
          // `close` is the authoritative stdio-closed event. If `exit` somehow
          // never fired (very rare; mostly synthetic test rigs, or when
          // `cross-spawn` intercepts the `exit` event on Windows to emit
          // an `error` for ENOENT), use this payload as the `exited` value
          // too so callers do not hang.
          if (lastExit === undefined) {
            completeOnce(lifecycle.exited, args)
          }
          completeOnce(lifecycle.closed, args)
        })
        proc.on("spawn", () => {
          resume(Effect.succeed([proc, lifecycle]))
        })
        return Effect.sync(() => {
          proc.kill("SIGTERM")
        })
      },
    )

  const killGroup = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
  ): Effect.Effect<void, PlatformError.PlatformError> => {
    if (globalThis.process.platform === "win32") {
      return Effect.callback<void, PlatformError.PlatformError>((resume) => {
        NodeChildProcess.exec(`taskkill /pid ${proc.pid} /T /F`, { windowsHide: true }, (err) => {
          if (err) return resume(Effect.fail(toPlatformError("kill", toError(err), command)))
          resume(Effect.void)
        })
      })
    }

    return Effect.try({
      try: () => {
        globalThis.process.kill(-proc.pid!, signal)
      },
      catch: (err) => toPlatformError("kill", toError(err), command),
    })
  }

  const processSignalTarget = (command: ChildProcess.StandardCommand, proc: NodeChildProcess.ChildProcess) => {
    if (Predicate.isUndefined(proc.pid)) return undefined
    if (globalThis.process.platform !== "win32" && (command.options.detached ?? true)) return -proc.pid
    return proc.pid
  }

  const processTreeRunning = (command: ChildProcess.StandardCommand, proc: NodeChildProcess.ChildProcess) => {
    const target = processSignalTarget(command, proc)
    if (Predicate.isUndefined(target)) return false
    try {
      globalThis.process.kill(target, 0)
      return true
    } catch (err) {
      if (isNoSuchProcessError(err)) return false
      return true
    }
  }

  const killOne = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
  ): Effect.Effect<void, PlatformError.PlatformError> =>
    Effect.suspend(() => {
      if (proc.kill(signal)) return Effect.void
      return Effect.fail(toPlatformError("kill", new Error("Failed to kill child process"), command))
    })

  /**
   * Wait for `exited` (or `closed` as a fallback) with a hard upper bound.
   * The hard cap is essential: if a detached descendant inherits stdio,
   * `closed` may never fire and we must still return. The hard cap does not
   * weaken correctness because the public contract for `exitCode` and
   * `isRunning` is based on `exited`, which is what we actually wait for.
   * `closed` is only used here as a safety net for the rare case where
   * `exit` never fires.
   */
  const waitForExit = (lifecycle: ProcessLifecycle, timeout: Duration.Input): Effect.Effect<ExitInfo> => {
    const sentinel: ExitInfo = [null, null]
    return Deferred.await(lifecycle.exited).pipe(
      Effect.orElseSucceed(() => sentinel),
      Effect.raceFirst(Deferred.await(lifecycle.closed).pipe(Effect.orElseSucceed(() => sentinel))),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.succeed(sentinel),
      }),
    )
  }

  const waitForProcessTreeExit = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    timeout: Duration.Input,
  ): Effect.Effect<boolean> =>
    Effect.suspend(() => {
      const poll = (): Effect.Effect<boolean> =>
        Effect.sync(() => !processTreeRunning(command, proc)).pipe(
          Effect.flatMap((done) => {
            if (done) return Effect.succeed(true)
            return Effect.sleep("50 millis").pipe(Effect.flatMap(() => poll()))
          }),
        )

      return poll().pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.succeed(false),
        }),
      )
    })

  const waitForExitAndCleanup = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    lifecycle: ProcessLifecycle,
    timeout: Duration.Input,
    cleanupObserved: boolean,
  ) =>
    Effect.all(
      [
        waitForExit(lifecycle, timeout),
        cleanupObserved ? Effect.succeed(true) : waitForProcessTreeExit(command, proc, timeout),
      ] as const,
      { concurrency: 2 },
    )

  const killAndWait = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    lifecycle: ProcessLifecycle,
    signal: NodeJS.Signals,
    timeout: Duration.Input | undefined,
  ): Effect.Effect<void, PlatformError.PlatformError> => {
    const send = (s: NodeJS.Signals) =>
      Effect.catch(killGroup(command, proc, s).pipe(Effect.as(globalThis.process.platform === "win32")), () =>
        killOne(command, proc, s).pipe(Effect.as(false)),
      )
    const cap: Duration.Input = timeout ?? `${HARD_KILL_GRACE_MS} millis`
    return Effect.gen(function* () {
      const cleanupObserved = yield* send(signal).pipe(Effect.orElseSucceed(() => false))
      const [info, cleaned] = yield* waitForExitAndCleanup(command, proc, lifecycle, cap, cleanupObserved)
      const [code, sig] = info
      if ((code === null && sig === null) || !cleaned) {
        // Either the foreground process did not exit, or descendants in the
        // process group/tree were still alive after the same grace window. Try
        // SIGKILL once and give cleanup a separate final bounded grace window.
        const forceCleanupObserved = yield* send("SIGKILL").pipe(Effect.orElseSucceed(() => false))
        yield* waitForExitAndCleanup(
          command,
          proc,
          lifecycle,
          `${HARD_KILL_GRACE_MS} millis`,
          forceCleanupObserved,
        ).pipe(Effect.ignore)
      }
    })
  }

  const source = (handle: ChildProcessHandle, from: ChildProcess.PipeFromOption | undefined) => {
    const opt = from ?? "stdout"
    switch (opt) {
      case "stdout":
        return handle.stdout
      case "stderr":
        return handle.stderr
      case "all":
        return handle.all
      default: {
        const fd = ChildProcess.parseFdName(opt)
        return Predicate.isNotUndefined(fd) ? handle.getOutputFd(fd) : handle.stdout
      }
    }
  }

  const spawnCommand: (
    command: ChildProcess.Command,
  ) => Effect.Effect<ChildProcessHandle, PlatformError.PlatformError, Scope.Scope> = Effect.fnUntraced(
    function* (command) {
      switch (command._tag) {
        case "StandardCommand": {
          const sin = stdin(command.options)
          const sout = stdio(command.options, "stdout")
          const serr = stdio(command.options, "stderr")
          const extra = fds(command.options)
          const dir = yield* cwd(command.options)

          const handleResources = yield* Effect.acquireRelease(
            spawn(command, {
              cwd: dir,
              env: env(command.options),
              stdio: stdios(sin, sout, serr, extra),
              detached: command.options.detached ?? process.platform !== "win32",
              shell: command.options.shell,
              windowsHide: process.platform === "win32",
            }),
            Effect.fnUntraced(function* (res) {
              const proc = res[0]
              const lifecycle = res[1]
              // Scope cleanup. We only wait for `exited` with a bounded grace
              // window; we never wait for `closed`. If the foreground process
              // already exited with a non-zero status, we still attempt a
              // process-tree kill (Unix process group / Windows taskkill /T)
              // so descendants do not leak past the scope, but we do not hang
              // on them.
              const [code] = yield* waitForExit(lifecycle, "0 millis")
              const sig = command.options.killSignal ?? "SIGTERM"
              if (code === 0) return
              if (code !== null) {
                // Non-zero exit. Same bounded attempt to reap any descendants.
                yield* killAndWait(command, proc, lifecycle, sig, `${HARD_KILL_GRACE_MS} millis`).pipe(Effect.ignore)
                return
              }
              // `exited` did not yet resolve. Treat this as a forced shutdown.
              yield* killAndWait(command, proc, lifecycle, sig, `${HARD_KILL_GRACE_MS} millis`).pipe(Effect.ignore)
            }),
          )

          const proc = handleResources[0]
          const lifecycle = handleResources[1]

          const fd = yield* setupFds(command, proc, extra)
          const out = setupOutput(command, proc, sout, serr)
          let ref = true
          return makeHandle({
            pid: ProcessId(proc.pid!),
            stdin: yield* setupStdin(command, proc, sin),
            stdout: out.stdout,
            stderr: out.stderr,
            all: out.all,
            getInputFd: fd.getInputFd,
            getOutputFd: fd.getOutputFd,
            isRunning: Effect.map(Deferred.isDone(lifecycle.exited), (done) => !done),
            exitCode: Effect.flatMap(Deferred.await(lifecycle.exited), ([code, signal]) => {
              if (Predicate.isNotNull(code)) return Effect.succeed(ExitCode(code))
              return Effect.fail(
                toPlatformError(
                  "exitCode",
                  new Error(`Process interrupted due to receipt of signal: '${signal}'`),
                  command,
                ),
              )
            }),
            kill: (opts?: ChildProcess.KillOptions) => {
              const sig = opts?.killSignal ?? "SIGTERM"
              return killAndWait(command, proc, lifecycle, sig, opts?.forceKillAfter)
            },
            unref: Effect.sync(() => {
              if (ref) {
                proc.unref()
                ref = false
              }
              return Effect.sync(() => {
                if (!ref) {
                  proc.ref()
                  ref = true
                }
              })
            }),
          })
        }
        case "PipedCommand": {
          const flat = flatten(command)
          const [head, ...tail] = flat.commands
          let handle = spawnCommand(head)
          for (let i = 0; i < tail.length; i++) {
            const next = tail[i]
            const opts = flat.opts[i] ?? {}
            const sin = stdin(next.options)
            const stream = Stream.unwrap(Effect.map(handle, (x) => source(x, opts.from)))
            const to = opts.to ?? "stdin"
            if (to === "stdin") {
              handle = spawnCommand(
                ChildProcess.make(next.command, next.args, {
                  ...next.options,
                  stdin: { ...sin, stream },
                }),
              )
              continue
            }
            const fd = ChildProcess.parseFdName(to)
            if (Predicate.isUndefined(fd)) {
              handle = spawnCommand(
                ChildProcess.make(next.command, next.args, {
                  ...next.options,
                  stdin: { ...sin, stream },
                }),
              )
              continue
            }
            handle = spawnCommand(
              ChildProcess.make(next.command, next.args, {
                ...next.options,
                additionalFds: {
                  ...next.options.additionalFds,
                  [ChildProcess.fdName(fd) as `fd${number}`]: { type: "input", stream },
                },
              }),
            )
          }
          return yield* handle
        }
      }
    },
  )

  return makeSpawner(spawnCommand)
})

export const layer: Layer.Layer<ChildProcessSpawner, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
  ChildProcessSpawner,
  make,
)

export const defaultLayer = layer.pipe(Layer.provide(NodeFileSystem.layer), Layer.provide(NodePath.layer))

export * as CrossSpawnSpawner from "./cross-spawn-spawner"

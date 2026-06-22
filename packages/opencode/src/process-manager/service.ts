import { Clock, Context, Deferred, Effect, Fiber, Layer, Scope, SynchronizedRef } from "effect"

import { liveProcessAdapter, ProcessAdapter } from "./adapter"
import { DEFAULT_MAX_BYTES, RingBuffer } from "./buffer"
import { ProcessHandle } from "./id"
import {
  POLL_DEFAULT_MAX_BYTES,
  POLL_DEFAULT_WAIT_MS,
  POLL_MAX_BYTES_HARD_CAP,
  POLL_MAX_WAIT_MS,
  type PollInput,
  type WriteInput,
} from "./schema"
import { ProcessError, ProcessInfo } from "./types"
import type { ManagedChild, ProcessErrorReason, ProcessState } from "./types"
import { InstanceState } from "@/effect/instance-state"

// Hard caps. Per-session is the limit a single shell session can hold; the
// global cap is the worst-case total the manager is willing to track across
// all sessions in one directory instance. Both kill the offending child at
// the boundary so we never leak a process outside the manager's accounting.
export const MAX_PER_SESSION = 8
export const MAX_GLOBAL = 32

// 30 minutes. The manager purges a record this long after `endedAt`; live
// records are kept indefinitely (until InstanceState teardown).
export const TTL_MS = 30 * 60 * 1000

// Internal record. The state lives in `SynchronizedRef<Map<handle, Record>>`
// so every method reads/writes the same authoritative copy per directory.
type Record = {
  readonly handle: ProcessHandle
  readonly ownerSessionID: string
  readonly command: string
  readonly cwd: string
  readonly startedAt: number
  endedAt: number | null
  state: ProcessState
  exitCode: number | null
  signal: string | null
  readonly child: ManagedChild
  readonly buffer: RingBuffer
  readonly stdinAvailable: boolean
  readonly pid: number | null
  // Caller-supplied hard deadline (ms). Captured at promote time so the
  // process tool can read it back. `null` means no timeout was set.
  readonly timeoutMs: number | null
  readonly onExit: Deferred.Deferred<{ exitCode: number | null; signal: string | null }, never>
  stopping: boolean
  // Active exit-watcher fiber. Held so the finalizer can interrupt it cleanly.
  watcher: Fiber.Fiber<void, unknown> | null
}

// Per-directory state. The `scope` is captured at InstanceState-make time
// and is the long-lived scope we fork exit-watchers into; it dies when the
// directory is torn down by InstanceState's finalizer.
type State = {
  records: SynchronizedRef.SynchronizedRef<Map<string, Record>>
  scope: Scope.Scope
}

export interface PromoteInput {
  readonly sessionID: string
  readonly command: string
  readonly cwd: string
  readonly pid: number | null
  readonly stdinAvailable: boolean
  readonly child: ManagedChild
  // Caller's hard deadline in milliseconds. `null` means no timeout was
  // supplied. Optional so existing call sites that predate the field can
  // omit it; the manager defaults to `null`. Stored verbatim on the record
  // and surfaced in `ProcessInfo`.
  readonly timeoutMs?: number | null
}

export type PollResponse = {
  readonly info: ProcessInfo
  readonly events: ReadonlyArray<{
    readonly kind: "stdout" | "stderr"
    readonly seq: number
    readonly text: string
    readonly at: number
  }>
  readonly nextCursor: number
  readonly truncatedBeforeCursor: boolean
}

export interface FeedInput {
  readonly sessionID: string
  readonly handle: ProcessHandle
  readonly kind: "stdout" | "stderr"
  readonly text: string
}

export interface ProcessManagerService {
  readonly promote: (input: PromoteInput) => Effect.Effect<ProcessInfo, ProcessError>
  readonly list: (input: { sessionID: string }) => Effect.Effect<ReadonlyArray<ProcessInfo>>
  readonly info: (input: {
    sessionID: string
    handle: ProcessHandle
  }) => Effect.Effect<ProcessInfo | undefined>
  readonly poll: (input: PollInput) => Effect.Effect<PollResponse | undefined>
  // Append a chunk of output to the record's bounded ring buffer. The spawner
  // (or test) pushes stdout/stderr chunks here as they arrive; `poll` reads
  // them back later. Returns `false` if the handle is unknown to the manager
  // or not owned by the supplied session — the caller can ignore the result
  // because ownership is the caller's responsibility, and the worst case is a
  // dropped chunk for a process the manager doesn't track.
  readonly feed: (input: FeedInput) => Effect.Effect<boolean>
  readonly write: (
    input: WriteInput,
  ) => Effect.Effect<{ bytesWritten: number } | undefined, ProcessError>
  readonly stop: (input: { sessionID: string; handle: ProcessHandle }) => Effect.Effect<ProcessInfo, ProcessError>
  readonly killAllForSession: (sessionID: string) => Effect.Effect<void>
  readonly killAll: () => Effect.Effect<void>
  readonly purgeExpired: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, ProcessManagerService>()(
  "@opencode/ProcessManager",
) {}

// Build a ProcessInfo snapshot from a record. The `inputClosed` flag is the
// only thing the manager has to consult external state for — once a child
// reports its stdin is gone, it stays gone.
function snapshot(rec: Record): ProcessInfo {
  return new ProcessInfo({
    handle: rec.handle,
    command: rec.command,
    cwd: rec.cwd,
    state: rec.state,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt ?? undefined,
    exitCode: rec.exitCode,
    signal: rec.signal,
    ownerSessionID: rec.ownerSessionID,
    pid: rec.pid,
    inputClosed: !rec.stdinAvailable,
    timeoutMs: rec.timeoutMs,
  })
}

function failWith(reason: ProcessErrorReason, message: string, handle?: ProcessHandle): ProcessError {
  return new ProcessError({ reason, message, ...(handle !== undefined ? { handle } : {}) })
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf-8")
}

// Build a ManagedChild from a generic child object the shell tool already
// owns. The shape is intentionally narrow — anything richer (kill options,
// stdio streams, exitCode promise) is the spawner's job, the manager only
// needs the few primitives below.
export function fromSpawnerChild(
  child: {
    readonly pid: number | null
    readonly exitCode: Promise<number> | Effect.Effect<number, never, never> | Effect.Effect<number, unknown, never>
    readonly kill?: (signal?: NodeJS.Signals) => void
    readonly stdin?: ManagedChild["stdin"]
  },
  stdinAvailable: boolean,
): ManagedChild {
  const exit = child.exitCode
  // Spawners usually hand back branded ExitCode (number & Brand<"ExitCode">)
  // with a non-`never` error channel; widen to the bare `number` shape the
  // manager expects. Failures in the spawner's effect are coerced to "no
  // exit code observed" — the manager treats a failure as the child having
  // been killed before it could report a clean exit.
  const widened: Effect.Effect<number, never, never> = Effect.isEffect(exit)
    ? exit.pipe(Effect.map((code) => Number(code)), Effect.orElseSucceed(() => -1))
    : Effect.promise(async () => exit)
  return {
    pid: child.pid,
    exitCode: widened,
    kill: child.kill ?? (() => {}),
    stdin: stdinAvailable ? child.stdin : undefined,
  }
}

export const layer: Layer.Layer<Service, never, ProcessAdapter> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const adapter = yield* ProcessAdapter

    const state = yield* InstanceState.make<State>(
      Effect.fn("ProcessManager.state")(function* () {
        const records = yield* SynchronizedRef.make(new Map<string, Record>())
        const scope = yield* Scope.Scope

        // When the directory is torn down, kill anything still alive. Best-
        // effort: the adapter call is wrapped in `Effect.ignore` so a single
        // ESRCH or taskkill hiccup doesn't block teardown.
        yield* Effect.addFinalizer(
          Effect.fn("ProcessManager.finalize")(function* () {
            const map = yield* SynchronizedRef.get(records)
            for (const rec of map.values()) {
              if (rec.endedAt === null && rec.pid !== null) {
                yield* adapter.stop({ pid: rec.pid, graceMs: 200 }).pipe(Effect.ignore)
              }
              if (rec.watcher) {
                yield* Fiber.interrupt(rec.watcher).pipe(Effect.ignore)
              }
            }
          }),
        )

        return { records, scope }
      }),
    )

    // ---- helpers ----

    const recordsRef = Effect.fn("ProcessManager.recordsRef")(function* () {
      return (yield* InstanceState.get(state)).records
    })

    const lookup = Effect.fn("ProcessManager.lookup")(function* (handle: ProcessHandle, sessionID: string) {
      const ref = yield* recordsRef()
      const map = yield* SynchronizedRef.get(ref)
      const rec = map.get(handle as unknown as string)
      if (!rec) return undefined
      if (rec.ownerSessionID !== sessionID) return undefined
      return rec
    })

    // ---- public methods ----

    const promote: ProcessManagerService["promote"] = Effect.fn("ProcessManager.promote")(function* (input) {
      const ref = yield* recordsRef()
      const map = yield* SynchronizedRef.get(ref)

      // 1. Generate a fresh handle. The shell tool that owns the live child
      // is expected to call `promote` exactly once per spawned process.
      const handle = ProcessHandle.ascending()
      const key = handle as unknown as string

      // 2. Per-session cap.
      const perSession = Array.from(map.values()).filter(
        (rec) => rec.ownerSessionID === input.sessionID,
      ).length
      if (perSession >= MAX_PER_SESSION) {
        if (input.pid !== null) yield* adapter.stop({ pid: input.pid, graceMs: 200 }).pipe(Effect.ignore)
        return yield* failWith(
          "LimitReached",
          `per-session limit (${MAX_PER_SESSION}) reached for session ${input.sessionID}`,
          handle,
        )
      }

      // 3. Global cap.
      if (map.size >= MAX_GLOBAL) {
        if (input.pid !== null) yield* adapter.stop({ pid: input.pid, graceMs: 200 }).pipe(Effect.ignore)
        return yield* failWith(
          "LimitReached",
          `global limit (${MAX_GLOBAL}) reached; refusing to track additional processes`,
          handle,
        )
      }

      // 4. Insert record. The exit watcher below flips the state to
      // `exited`/`failed` once the child terminates.
      const startedAt = yield* Clock.currentTimeMillis
      const onExit = yield* Deferred.make<{ exitCode: number | null; signal: string | null }, never>()
      const record: Record = {
        handle,
        ownerSessionID: input.sessionID,
        command: input.command,
        cwd: input.cwd,
        startedAt,
        endedAt: null,
        state: "starting",
        exitCode: null,
        signal: null,
        child: input.child,
        buffer: new RingBuffer(DEFAULT_MAX_BYTES),
        stdinAvailable: input.stdinAvailable,
        pid: input.pid,
        timeoutMs: input.timeoutMs ?? null,
        onExit,
        stopping: false,
        watcher: null,
      }

      const { scope } = yield* InstanceState.get(state)

      // 5. Fork the long-lived exit watcher. It owns the state transition
      // from `running` to `exited` / `failed` and resolves `onExit` once.
      const watcher: Fiber.Fiber<void, unknown> = yield* Effect.forkIn(
        Effect.gen(function* () {
          const exitCode = yield* input.child.exitCode
          const endedAt = yield* Clock.currentTimeMillis
          yield* SynchronizedRef.modify(yield* recordsRef(), (m) => {
            const cur = m.get(key)
            if (!cur) return [undefined, m] as const
            // Caller already marked it stopped -> don't override.
            if (cur.stopping) return [undefined, m] as const
            const terminal: ProcessState = exitCode === 0 ? "exited" : "failed"
            const next: Record = {
              ...cur,
              state: terminal,
              endedAt,
              exitCode,
              signal: null,
            }
            void Deferred.succeed(onExit, { exitCode, signal: null })
            return [undefined, new Map(m).set(key, next)] as const
          })
        }).pipe(
          Effect.catchCause(() => Effect.void),
          Effect.asVoid,
        ),
        scope,
      )

      const promoted: Record = { ...record, state: "running", watcher }
      yield* SynchronizedRef.modify(yield* recordsRef(), (m) => {
        return [undefined, new Map(m).set(key, promoted)] as const
      })

      return snapshot(promoted)
    })

    const list: ProcessManagerService["list"] = Effect.fn("ProcessManager.list")(function* (input) {
      const map = yield* SynchronizedRef.get(yield* recordsRef())
      return Array.from(map.values())
        .filter((rec) => rec.ownerSessionID === input.sessionID)
        .map(snapshot)
        .toSorted((a, b) => a.startedAt - b.startedAt)
    })

    const info: ProcessManagerService["info"] = Effect.fn("ProcessManager.info")(function* (input) {
      const rec = yield* lookup(input.handle, input.sessionID)
      if (!rec) return undefined
      return snapshot(rec)
    })

    const poll: ProcessManagerService["poll"] = Effect.fn("ProcessManager.poll")(function* (input) {
      const rec = yield* lookup(input.handle, input.sessionID)
      if (!rec) return undefined

      const maxBytes = Math.min(input.maxBytes ?? POLL_DEFAULT_MAX_BYTES, POLL_MAX_BYTES_HARD_CAP)
      const waitMs = Math.min(input.waitMs ?? POLL_DEFAULT_WAIT_MS, POLL_MAX_WAIT_MS)

      if (
        waitMs > 0 &&
        rec.state !== "exited" &&
        rec.state !== "failed" &&
        rec.state !== "stopped"
      ) {
        yield* Effect.sleep(`${waitMs} millis`)
      }

      const cursor = input.cursor ?? 0
      const { events, nextCursor, truncatedBeforeCursor } = rec.buffer.since(cursor)

      // Apply per-call maxBytes on the response (cumulative cap on the wire,
      // separate from the buffer's internal cap). Walk from the newest event
      // backward, accumulating bytes; drop everything older than the
      // overflow point. Always keep at least the last event.
      let start = 0
      if (events.length > 0) {
        let total = 0
        for (let i = events.length - 1; i >= 0; i--) {
          const cost = byteLength(events[i]!.text)
          if (total + cost > maxBytes) {
            start = i + 1
            break
          }
          total += cost
          if (i === 0) start = 0
        }
      }
      const trimmed = events.slice(start)

      return {
        info: snapshot(rec),
        events: trimmed,
        nextCursor: trimmed.length === 0 ? nextCursor : trimmed[trimmed.length - 1]!.seq,
        truncatedBeforeCursor: truncatedBeforeCursor || start > 0,
      }
    })

    const feed: ProcessManagerService["feed"] = Effect.fn("ProcessManager.feed")(function* (input) {
      const rec = yield* lookup(input.handle, input.sessionID)
      if (!rec) return false
      rec.buffer.append(input.kind, input.text, Date.now())
      return true
    })

    const write: ProcessManagerService["write"] = Effect.fn("ProcessManager.write")(function* (input) {
      const rec = yield* lookup(input.handle, input.sessionID)
      if (!rec) return undefined
      if (rec.state !== "running" && rec.state !== "starting") {
        return yield* failWith(
          "NotRunning",
          `process ${input.handle} is not running (state=${rec.state})`,
          input.handle,
        )
      }
      if (!rec.stdinAvailable) {
        return yield* failWith(
          "StdinClosed",
          `process ${input.handle} stdin is closed`,
          input.handle,
        )
      }
      const stdin = rec.child.stdin
      if (!stdin) {
        return yield* failWith(
          "StdinClosed",
          `process ${input.handle} has no stdin handle`,
          input.handle,
        )
      }
      const data = input.appendNewline ? input.data + "\n" : input.data
      yield* stdin.write(data)
      return { bytesWritten: byteLength(data) }
    })

    const stop: ProcessManagerService["stop"] = Effect.fn("ProcessManager.stop")(function* (input) {
      const rec = yield* lookup(input.handle, input.sessionID)
      if (!rec) return yield* failWith("NotFound", `process ${input.handle} not found`, input.handle)
      if (rec.state === "exited" || rec.state === "failed" || rec.state === "stopped") {
        return snapshot(rec)
      }

      const ref = yield* recordsRef()
      const key = input.handle as unknown as string

      if (rec.pid === null) {
        // No pid -> no signal we can send. Flip state directly.
        const endedAt = yield* Clock.currentTimeMillis
        const next: Record = {
          ...rec,
          state: "stopped",
          endedAt,
          exitCode: null,
          signal: null,
          stopping: true,
        }
        yield* SynchronizedRef.modify(ref, (m) => {
          return [undefined, new Map(m).set(key, next)] as const
        })
        void Deferred.succeed(rec.onExit, { exitCode: null, signal: null })
        return snapshot(next)
      }

      // Mark `stopping` first so the exit watcher doesn't race us into
      // `failed` for a clean signal-driven exit.
      yield* SynchronizedRef.modify(ref, (m) => {
        const cur = m.get(key)
        if (!cur) return [undefined, m] as const
        const next: Record = { ...cur, stopping: true }
        return [undefined, new Map(m).set(key, next)] as const
      })

      yield* adapter.stop({ pid: rec.pid, graceMs: 200 })
      const endedAt = yield* Clock.currentTimeMillis
      const final: Record = {
        ...rec,
        state: "stopped",
        endedAt,
        exitCode: rec.exitCode,
        signal: rec.signal,
        stopping: true,
      }
      yield* SynchronizedRef.modify(ref, (m) => {
        return [undefined, new Map(m).set(key, final)] as const
      })
      void Deferred.succeed(rec.onExit, { exitCode: rec.exitCode, signal: rec.signal })
      return snapshot(final)
    })

    const killAllForSession: ProcessManagerService["killAllForSession"] = Effect.fn(
      "ProcessManager.killAllForSession",
    )(function* (sessionID) {
      const map = yield* SynchronizedRef.get(yield* recordsRef())
      const targets = Array.from(map.values()).filter(
        (rec) =>
          rec.ownerSessionID === sessionID && rec.endedAt === null && rec.pid !== null,
      )
      yield* Effect.forEach(
        targets,
        (rec) => adapter.stop({ pid: rec.pid!, graceMs: 200 }).pipe(Effect.ignore),
        { concurrency: "unbounded" },
      )
    })

    const killAll: ProcessManagerService["killAll"] = Effect.fn("ProcessManager.killAll")(function* () {
      const map = yield* SynchronizedRef.get(yield* recordsRef())
      const targets = Array.from(map.values()).filter(
        (rec) => rec.endedAt === null && rec.pid !== null,
      )
      yield* Effect.forEach(
        targets,
        (rec) => adapter.stop({ pid: rec.pid!, graceMs: 200 }).pipe(Effect.ignore),
        { concurrency: "unbounded" },
      )
    })

    const purgeExpired: ProcessManagerService["purgeExpired"] = Effect.fn("ProcessManager.purgeExpired")(
      function* () {
        const now = yield* Clock.currentTimeMillis
        yield* SynchronizedRef.modify(yield* recordsRef(), (m) => {
          let changed = false
          const next = new Map(m)
          for (const [key, rec] of m) {
            if (rec.endedAt !== null && now - rec.endedAt >= TTL_MS) {
              next.delete(key)
              changed = true
            }
          }
          return [undefined, changed ? next : m] as const
        })
      },
    )

    // Background loop: purge expired records every 60s. Forked in the layer's
    // outer scope so the loop dies with the layer, not with the calling tool.
    yield* Effect.forkIn(
      Effect.gen(function* () {
        for (;;) {
          yield* Effect.sleep("60 seconds")
          yield* purgeExpired().pipe(Effect.ignore)
        }
      }).pipe(Effect.forever, Effect.asVoid),
      yield* Scope.Scope,
    )

    return Service.of({ promote, list, info, poll, feed, write, stop, killAllForSession, killAll, purgeExpired })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Layer.succeed(ProcessAdapter)(liveProcessAdapter)),
)

export * as ProcessManager from "./service"

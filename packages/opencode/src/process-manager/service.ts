import { Clock, Context, Deferred, Effect, Fiber, Layer, Option, Scope, Stream, SynchronizedRef } from "effect"

import { liveProcessAdapter, ProcessAdapter } from "./adapter"
import { DEFAULT_MAX_BYTES, RingBuffer } from "./buffer"
import { ProcessHandle } from "./id"
import {
  POLL_DEFAULT_MAX_BYTES,
  POLL_MAX_BYTES_HARD_CAP,
  POLL_MAX_WAIT_MS,
  POLL_MIN_WAIT_MS,
  type PollInput,
  type PollWaitStatus,
  type PromoteInput,
} from "./schema"
import { ProcessError, ProcessInfo } from "./types"
import type { ManagedChild, ProcessErrorReason, ProcessState } from "./types"
import { InstanceState } from "@/effect/instance-state"

// An effect that closes the caller-supplied scope. The shell tool
// produces this from `Scope.close(longScope, Exit.void)` and hands it
// to the manager on successful promote. The manager runs it exactly
// once per record on the first terminal transition so the spawner's
// acquireRelease finalizers fire and the stdin/stdout/stderr file
// descriptors are released. We type it as `Effect<void, never, never>`
// for documentation; the actual value carries whatever R channel the
// shell tool produced (typically Scope) and the manager just calls it
// inside the layer's environment so the dependency is satisfied.
export type OwnedScopeRelease = Effect.Effect<void, never, never>

// Codex-like process store cap. A full store prunes old records instead of
// hard-rejecting immediately; the 8 most recently used records are protected,
// terminal records are preferred for removal, and only then can the least
// recently used live record be stopped and removed.
export const MAX_GLOBAL = 64
export const RECENT_PROCESS_PROTECT_COUNT = 8

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
  lastUsedAt: number
  endedAt: number | null
  state: ProcessState
  exitCode: number | null
  signal: string | null
  terminationReason: "timeout" | "stopped" | "natural" | null
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
  // Active timeout-watcher fiber. Held so `killAll*`/finalizers can interrupt
  // it cleanly when they decide to terminate the record themselves.
  timeoutWatcher: Fiber.Fiber<void, unknown> | null
  // Active stdio capture fibers. The capture finalizer attached to the
  // record's lifetime interrupts these so the bounded ring buffer stops
  // accepting new chunks once the record is purged.
  captureFibers: ReadonlyArray<Fiber.Fiber<void, unknown>>
  // Caller-supplied scope release. The shell tool creates a long-lived
  // `Scope.make()` to host the spawner's acquireRelease finalizers and
  // hands ownership to the manager on successful promote. Every
  // terminal path closes the scope at most once (idempotent) so we
  // never leak the spawner's finalizers. Absent for internal-only
  // records (e.g. tests that don't transfer scope ownership).
  ownedRelease: OwnedScopeRelease | null
  // Guard so we close the caller-owned scope at most once. Set on the
  // first terminal transition; further transitions see it as already
  // closed and skip the release call.
  ownedScopeClosed: boolean
  // Long-poll wake channel. Output appends and terminal transitions complete
  // the current deferred so any fiber parked inside `poll` returns before its
  // deadline. Shared by reference across immutable record copies.
  readonly pollNotifier: PollNotifier
}

// Per-directory state. The `scope` is captured at InstanceState-make time
// and is the long-lived scope we fork exit-watchers into; it dies when the
// directory is torn down by InstanceState's finalizer.
type State = {
  records: SynchronizedRef.SynchronizedRef<Map<string, Record>>
  scope: Scope.Scope
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
  readonly waitStatus: PollWaitStatus
}

// Why a long-poll waiter was woken. Output appends and terminal transitions
// both wake any fiber parked inside `poll`.
type PollWakeReason = "output" | "terminal"

// Shared, mutable notifier carried on each record. We hold a plain object with
// a swappable `Deferred` instead of putting the `Deferred` directly on the
// record so the immutable record copies (`{ ...cur }`) all observe the SAME
// notifier reference — completing the deferred wakes every parked poller, and
// the next wait round installs a fresh deferred.
type PollNotifier = {
  deferred: Deferred.Deferred<PollWakeReason, never>
}

// Normalize an empty-poll `wait_ms` to Codex bounds. `undefined`/`<= 0` means a
// non-blocking immediate poll; any positive value is clamped into
// [POLL_MIN_WAIT_MS, POLL_MAX_WAIT_MS]. Exported for direct unit testing.
export function normalizePollWaitMs(value: number | undefined): number {
  if (value === undefined || value <= 0) return 0
  return Math.min(Math.max(value, POLL_MIN_WAIT_MS), POLL_MAX_WAIT_MS)
}

export interface FeedInput {
  readonly sessionID: string
  readonly handle: ProcessHandle
  readonly kind: "stdout" | "stderr"
  readonly text: string
}

export interface ProcessManagerService {
  readonly promote: (
    input: PromoteInput,
  ) => Effect.Effect<ProcessInfo, ProcessError, Scope.Scope>
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
    terminationReason: rec.terminationReason,
  })
}

function failWith(reason: ProcessErrorReason, message: string, handle?: ProcessHandle): ProcessError {
  return new ProcessError({ reason, message, ...(handle !== undefined ? { handle } : {}) })
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf-8")
}

// Run the caller's owned-scope release effect at most once. The release
// is whatever the shell tool produced from `Scope.close(longScope, Exit.void)`
// at promote time — running it closes the long-lived scope the spawner
// lives in, which fires the spawner's acquireRelease finalizers
// (closing stdin/stdout/stderr fds). Subsequent calls are no-ops so a
// natural exit, timeout, and explicit stop that race on the same record
// do not double-release. Failures are best-effort: we ignore the error
// channel because the manager's record state is already terminal and a
// half-closed scope does not corrupt it.
const closeOwnedScope = (rec: Record): Effect.Effect<void, never, never> => {
  if (rec.ownedScopeClosed) return Effect.void
  if (!rec.ownedRelease) return Effect.void
  rec.ownedScopeClosed = true
  return rec.ownedRelease.pipe(Effect.ignore, Effect.asVoid)
}

// Drain a stream-like value into the record's ring buffer. Accepts either
// an Effect `Stream.Stream<Uint8Array, ...>` (the shape the ChildProcessSpawner
// hands back) or a `ReadableStream<Uint8Array>` (Bun.spawn, manual tests).
// The fiber returns when the stream completes; in-flight chunks already
// offered into the buffer stay there. `Effect.addFinalizer` on the outer
// scope interrupts the underlying reader/puller so the OS file descriptor
// is released when the record is purged.
function drainStream(
  stream: unknown,
  buffer: RingBuffer,
  kind: "stdout" | "stderr",
  notify: Effect.Effect<void, never, never>,
): Effect.Effect<void, never, Scope.Scope> {
  // One decoder for the entire stream lifetime. Reused on every chunk so
  // split UTF-8 sequences are reassembled before we append text to the
  // ring buffer. Creating a fresh decoder per chunk (the v2 regression)
  // breaks characters whose bytes are split across `stdout.write` calls
  // — `こんにちは` becomes `ããããã` or drops bytes.
  const decoder = new TextDecoder()
  // Append decoded text and return whether anything was appended, so the
  // caller can wake parked pollers ONLY on a real output event.
  const append = (text: string) => {
    if (text.length === 0) return false
    buffer.append(kind, text, Date.now())
    return true
  }

  // Path 1: Web ReadableStream. Iterate chunks via reader.read().
  if (stream instanceof ReadableStream) {
    return Effect.gen(function* () {
      const reader = stream.getReader()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            reader.releaseLock()
          } catch {}
        }),
      )
      try {
        while (true) {
          const { value, done } = yield* Effect.promise(() => reader.read())
          if (done) break
          if (value && append(decoder.decode(value, { stream: true }))) yield* notify
        }
      } catch {
        // Best-effort: errors during read mean the underlying handle is
        // already gone (child exit, OS reset). Buffer already accepts chunks
        // synchronously so nothing to roll back here.
      }
      // Always flush at end-of-stream / on interruption so any partial
      // multi-byte sequences surface as text (or the U+FFFD replacement)
      // rather than being silently dropped.
      if (append(decoder.decode())) yield* notify
    }).pipe(Effect.ignore)
  }

  // Path 2: Effect Stream. Use the typed runner for Stream<Uint8Array>.
  // The runner's end-of-stream is signalled by forEach returning; we
  // wrap it in `Effect.ensuring` so the tail flush runs on the happy
  // path, on error, AND on interruption. The decoder instance is the
  // same one the chunk callback used, so any buffered tail bytes that
  // did not yet form a complete code point are emitted as text.
  if (Stream.isStream(stream)) {
    return Stream.runForEach(
      stream as Stream.Stream<Uint8Array, never, never>,
      (chunk) =>
        Effect.gen(function* () {
          if (append(decoder.decode(chunk, { stream: true }))) yield* notify
        }),
    ).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (append(decoder.decode())) yield* notify
        }),
      ),
      Effect.ignore,
    )
  }

  // Unknown shape — skip capture silently. The caller can still drive the
  // buffer via `feed(...)`.
  return Effect.void
}

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

// Core manager layer: covers `promote`, `list`, `info`, `poll`, `feed`,
// `stop`, `killAll*`, `purgeExpired`. There is intentionally no public
// `write` action (stdin is spawned as "ignore"). The shell tool passes
// the live `ChildProcessHandle` it already owns to `promote`; the
// manager tracks the child but does not own the spawner scope.
export const layer: Layer.Layer<Service, never, ProcessAdapter> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const adapter = yield* ProcessAdapter

    const state = yield* InstanceState.make<State>(
      Effect.fn("ProcessManager.state")(function* () {
        const records = yield* SynchronizedRef.make(new Map<string, Record>())
        // The contextual scope (`yield* Scope.Scope`) is the long-lived
        // scope InstanceState ties the finalizer to — forking fibers into
        // it means they die with the directory.
        const scope = yield* Scope.Scope

        // When the directory is torn down, kill anything still alive. Best-
        // effort: the adapter call is wrapped in `Effect.ignore` so a single
        // ESRCH or taskkill hiccup doesn't block teardown. Close the
        // caller-owned scope for every live record so the spawner's
        // acquireRelease finalizers fire and no scope leaks across
        // directory teardown.
        yield* Effect.addFinalizer(
          Effect.fn("ProcessManager.finalize")(function* () {
            const map = yield* SynchronizedRef.get(records)
            for (const rec of map.values()) {
              if (rec.endedAt === null && rec.pid !== null) {
                yield* adapter.stop({ pid: rec.pid, graceMs: 200 }).pipe(Effect.ignore)
              }
              if (rec.watcher) yield* Fiber.interrupt(rec.watcher).pipe(Effect.ignore)
              if (rec.timeoutWatcher) yield* Fiber.interrupt(rec.timeoutWatcher).pipe(Effect.ignore)
              for (const f of rec.captureFibers) yield* Fiber.interrupt(f).pipe(Effect.ignore)
              yield* closeOwnedScope(rec)
            }
          }),
        )

        return { records, scope } as const
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

    // Mutate a record's state in one step. Returns the next record (so callers
    // can keep using `rec`-shaped values) and yields `undefined` value.
    const mutate = Effect.fn("ProcessManager.mutate")(
      function* (handle: ProcessHandle, fn: (rec: Record) => Record | undefined) {
        const ref = yield* recordsRef()
        const key = handle as unknown as string
        let result: Record | undefined
        yield* SynchronizedRef.modify(ref, (m) => {
          const cur = m.get(key)
          if (!cur) return [undefined, m] as const
          const next = fn(cur)
          if (!next) return [undefined, m] as const
          if (next === cur) return [undefined, m] as const
          result = next
          return [undefined, new Map(m).set(key, next)] as const
        })
        return result
      },
    )

    const isLive = (rec: Record) => rec.state === "starting" || rec.state === "running"
    const isTerminal = (rec: Record) => !isLive(rec)

    // Wake every fiber parked on this record's notifier and install a fresh
    // deferred for the next wait round. Completing the captured deferred is
    // idempotent and never fails (the channel error type is `never`); a
    // double-complete from a racing wake is ignored.
    const wakeNotifier = Effect.fn("ProcessManager.wakeNotifier")(function* (
      notifier: PollNotifier,
      reason: PollWakeReason,
    ) {
      const current = notifier.deferred
      notifier.deferred = yield* Deferred.make<PollWakeReason, never>()
      yield* Deferred.succeed(current, reason).pipe(Effect.ignore)
    })

    const removeRecord = Effect.fn("ProcessManager.removeRecord")(function* (
      rec: Record,
      options?: { readonly stopLive?: boolean },
    ) {
      if (options?.stopLive && isLive(rec)) {
        // Mutate `rec` itself to a terminal snapshot BEFORE deleting it from
        // the map. Parked long polls in `poll(...)` fall back to `rec` when
        // the map lookup misses (the record was just removed), and they
        // classify wake reasons from the returned `latest` state. If we
        // mutated a copy or a fresh record, the stale `rec` reference the
        // poller captured on entry would still report `running` and the
        // poller would either (a) sleep through the deadline, or (b) wake
        // and report a stale "running" snapshot. Mutating in place is
        // intentional and scoped to this prune path. The condition is
        // intentionally pid-independent: pid is only consulted to decide
        // whether `adapter.stop` is callable. Internal-only records (e.g.
        // adapters or tests that promote with `pid: null`) are still live
        // and must wake any parked poller — otherwise a long poll against
        // a pidless live victim would sleep out the full wait window.
        const endedAt = yield* Clock.currentTimeMillis
        rec.stopping = true
        rec.state = "stopped"
        rec.endedAt = endedAt
        rec.terminationReason = "stopped"
        if (rec.pid !== null) {
          yield* adapter.stop({ pid: rec.pid, graceMs: 200 }).pipe(Effect.ignore)
        }
        void Deferred.succeed(rec.onExit, { exitCode: rec.exitCode, signal: rec.signal })
        // Wake any poller parked on this record's notifier. The pruner is
        // the only terminal path that does not already wake pollers (the
        // other terminal paths route through `mutate` + their own wake).
        // Without this, a long poll would sleep out the full wait window
        // and return a "timeout" against a record that no longer exists.
        yield* wakeNotifier(rec.pollNotifier, "terminal")
      }
      if (rec.watcher) yield* Fiber.interrupt(rec.watcher).pipe(Effect.ignore)
      if (rec.timeoutWatcher) yield* Fiber.interrupt(rec.timeoutWatcher).pipe(Effect.ignore)
      for (const f of rec.captureFibers) yield* Fiber.interrupt(f).pipe(Effect.ignore)
      yield* closeOwnedScope(rec)
      const ref = yield* recordsRef()
      const key = rec.handle as unknown as string
      yield* SynchronizedRef.modify(ref, (m) => {
        const next = new Map(m)
        next.delete(key)
        return [undefined, next] as const
      })
    })

    const pruneForGlobalCap = Effect.fn("ProcessManager.pruneForGlobalCap")(function* (sessionID: string) {
      const map = yield* SynchronizedRef.get(yield* recordsRef())
      if (map.size < MAX_GLOBAL) return true

      const entries = Array.from(map.entries())
      const protectedKeys = new Set(
        entries
          .toSorted((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)
          .slice(0, RECENT_PROCESS_PROTECT_COUNT)
          .map(([key]) => key),
      )
      const unprotected = entries.filter(([key]) => !protectedKeys.has(key)).map(([, rec]) => rec)

      // Prefer pruning a terminal record. Terminal records are dead, so
      // removing one across any session only frees a slot — it never stops a
      // running job.
      const terminalVictim = unprotected
        .filter((rec) => !isLive(rec))
        .toSorted((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
      if (terminalVictim) {
        yield* removeRecord(terminalVictim)
        return true
      }

      // No terminal record is available. Only then do we terminate a live
      // process — and only one owned by the promoting session, so a session
      // can never stop another session's running job to make room for its
      // own. This preserves the manager's session-ownership boundary even
      // under the global cap. If the caller has no unprotected live record to
      // give up, reject the promote rather than crossing the boundary.
      const liveVictim = unprotected
        .filter((rec) => isLive(rec) && rec.ownerSessionID === sessionID)
        .toSorted((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
      if (!liveVictim) return false
      yield* removeRecord(liveVictim, { stopLive: true })
      return true
    })

    // ---- public methods ----

    const promote: ProcessManagerService["promote"] = Effect.fn("ProcessManager.promote")(function* (input) {
      const ref = yield* recordsRef()
      const child = input.child as ManagedChild

      // 1. Generate a fresh handle. The shell tool that owns the live child
      // is expected to call `promote` exactly once per spawned process.
      const handle = ProcessHandle.ascending()
      const key = handle as unknown as string

      // 2. Global cap. A full store prunes old records first. Recent records
      // are protected; terminal records are removed before live records. Only
      // if no prune candidate exists do we reject and kill the candidate child.
      const pruned = yield* pruneForGlobalCap(input.sessionID)
      const map = yield* SynchronizedRef.get(ref)
      if (!pruned || map.size >= MAX_GLOBAL) {
        if (input.pid !== null) yield* adapter.stop({ pid: input.pid, graceMs: 200 }).pipe(Effect.ignore)
        return yield* failWith(
          "LimitReached",
          `global limit (${MAX_GLOBAL}) reached; no unprotected process could be pruned`,
          handle,
        )
      }

      // 3. Insert record. The exit watcher below flips the state to
      // `exited`/`failed` once the child terminates.
      const startedAt = yield* Clock.currentTimeMillis
      const onExit = yield* Deferred.make<{ exitCode: number | null; signal: string | null }, never>()
      const record: Record = {
        handle,
        ownerSessionID: input.sessionID,
        command: input.command,
        cwd: input.cwd,
        startedAt,
        lastUsedAt: startedAt,
        endedAt: null,
        state: "starting",
        exitCode: null,
        signal: null,
        terminationReason: null,
        child,
        buffer: new RingBuffer(DEFAULT_MAX_BYTES),
        stdinAvailable: input.stdinAvailable,
        pid: input.pid,
        timeoutMs: input.timeoutMs ?? null,
        onExit,
        stopping: false,
        watcher: null,
        timeoutWatcher: null,
        captureFibers: [],
        // Take ownership of the caller-supplied scope release (cast at
        // the manager boundary; the schema accepts `unknown` so the LLM
        // surface stays narrow). On the first terminal transition the
        // watcher / stop / killAll paths close this exactly once via
        // `closeOwnedScope`. On promote failure the caller closes its
        // own scope.
        ownedRelease: (input.release ?? null) as OwnedScopeRelease | null,
        ownedScopeClosed: false,
        pollNotifier: { deferred: yield* Deferred.make<PollWakeReason, never>() },
      }

      const { scope } = yield* InstanceState.get(state)

      // 4. Fork the long-lived exit watcher. It owns the state transition
      // from `running` to `exited` / `failed` and resolves `onExit` once.
      // On every transition we close the caller-owned scope (idempotent)
      // so the spawner's acquireRelease finalizers fire and the OS file
      // descriptors are released.
      const watcher: Fiber.Fiber<void, unknown> = yield* Effect.forkIn(
        Effect.gen(function* () {
          const exitCode = yield* child.exitCode
          const endedAt = yield* Clock.currentTimeMillis
          const next = yield* mutate(handle, (cur) => {
            // Caller already marked it stopped -> don't override.
            if (cur.stopping) return cur
            const terminal: ProcessState = exitCode === 0 ? "exited" : "failed"
            return {
              ...cur,
              state: terminal,
              endedAt,
              exitCode,
              signal: null,
              terminationReason: "natural",
            }
          })
          if (next) {
            yield* closeOwnedScope(next)
            yield* wakeNotifier(next.pollNotifier, "terminal")
            void Deferred.succeed(onExit, { exitCode, signal: null })
          }
        }).pipe(
          Effect.catchCause(() => Effect.void),
          Effect.asVoid,
        ),
        scope,
      )

      // 5. Fork the long-lived hard-timeout watcher. Fires once after the
      // caller's `timeoutMs`; marks the record `failed` with `signal: "TIMEOUT"`
      // and a `terminationReason: "timeout"`. The watcher is a no-op once the
      // record has already ended (via natural exit or explicit stop). It is
      // also interrupted when the record is stopped/killed so we don't try to
      // terminate a child the caller has already taken ownership of.
      const timeoutMs = input.timeoutMs ?? null
      const timeoutWatcher: Fiber.Fiber<void, unknown> | null =
        timeoutMs && timeoutMs > 0
          ? yield* Effect.forkIn(
              Effect.gen(function* () {
                yield* Effect.sleep(`${timeoutMs} millis`)
                const endedAt = yield* Clock.currentTimeMillis
                const next = yield* mutate(handle, (cur) => {
                  if (cur.endedAt !== null) return cur
                  if (cur.stopping) return cur
                  return {
                    ...cur,
                    state: "failed" as const,
                    endedAt,
                    exitCode: null,
                    signal: "TIMEOUT",
                    terminationReason: "timeout" as const,
                    stopping: true,
                  }
                })
                if (next && next.pid !== null) {
                  yield* adapter.stop({ pid: next.pid, graceMs: 200 }).pipe(Effect.ignore)
                }
                if (next) {
                  yield* closeOwnedScope(next)
                  yield* wakeNotifier(next.pollNotifier, "terminal")
                  void Deferred.succeed(next.onExit, { exitCode: null, signal: "TIMEOUT" })
                }
              }).pipe(
                Effect.catchCause(() => Effect.void),
                Effect.asVoid,
              ),
              scope,
            )
          : null

      // 6. Manager-owned output capture. If the caller passed live stdio
      // streams, fork a long-lived drain fiber per stream into the same
      // scope so it dies with the record. The fiber is interrupted by the
      // record's purge finalizer (see InstanceState teardown) and by the
      // buffer's natural close.
      const captureFibers: Array<Fiber.Fiber<void, unknown>> = []
      if (input.stdout) {
        const f = yield* Effect.forkIn(
          drainStream(
            input.stdout,
            record.buffer,
            "stdout",
            wakeNotifier(record.pollNotifier, "output"),
          ).pipe(Effect.asVoid),
          scope,
        )
        captureFibers.push(f)
      }
      if (input.stderr) {
        const f = yield* Effect.forkIn(
          drainStream(
            input.stderr,
            record.buffer,
            "stderr",
            wakeNotifier(record.pollNotifier, "output"),
          ).pipe(Effect.asVoid),
          scope,
        )
        captureFibers.push(f)
      }

      // 7. Seed pre-promote output into the ring buffer. The shell tool
      // stops its local capture/persist fibers BEFORE calling `promote`,
      // drains them into a single `prePromoteStdout` (and future
      // `prePromoteStderr`) string, and hands those strings to the
      // manager here. Appending them to the buffer BEFORE the record is
      // inserted guarantees two invariants:
      //
      //   a) The first `process poll` after promote returns the
      //      pre-promote snapshot rather than only post-promote chunks
      //      from the manager's drainStream fibers. This is the contract
      //      documented on `PromoteInput.prePromoteOutput` (see
      //      schema.ts).
      //   b) The pre-promote events get strictly LOWER seq numbers than
      //      any post-promote chunk the manager drains, because the
      //      ring buffer is single-writer and capture fibers append
      //      only after this point. Cursors issued before any
      //      post-promote output remains cursor=0 plus however many
      //      seed events we wrote.
      //
      // We append stdout first, then stderr, to match the foreground
      // ordering the shell tool already produced (list joined in
      // arrival order; both streams are independently UTF-8-decoded
      // before this point so there is no byte-boundary concern).
      const pre = input.prePromoteOutput ?? null
      if (pre?.stdout) record.buffer.append("stdout", pre.stdout, startedAt)
      if (pre?.stderr) record.buffer.append("stderr", pre.stderr, startedAt)

      const promoted: Record = {
        ...record,
        state: "running",
        watcher,
        timeoutWatcher,
        captureFibers,
      }
      yield* SynchronizedRef.modify(ref, (m) => {
        return [undefined, new Map(m).set(key, promoted)] as const
      })

      return snapshot(promoted)
    })

    const list: ProcessManagerService["list"] = Effect.fn("ProcessManager.list")(function* (input) {
      const map = yield* SynchronizedRef.get(yield* recordsRef())
      return Array.from(map.values())
        .filter((rec) => rec.ownerSessionID === input.sessionID && isLive(rec))
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
      const now = yield* Clock.currentTimeMillis
      yield* mutate(input.handle, (cur) => ({ ...cur, lastUsedAt: now }))

      const maxBytes = Math.min(input.maxBytes ?? POLL_DEFAULT_MAX_BYTES, POLL_MAX_BYTES_HARD_CAP)
      const waitMs = normalizePollWaitMs(input.waitMs)
      const cursor = input.cursor ?? 0
      // The notifier reference is stable across immutable record copies, so we
      // capture it once. Capturing the deferred BEFORE each buffer read closes
      // the lost-wakeup window: an append/terminal that races a parked poller
      // either lands in the buffer we re-read or completes the deferred we await.
      const notifier = rec.pollNotifier

      // Build the LLM-facing response from the freshest record + buffer state.
      // Applies the per-call maxBytes cap (cumulative cap on the wire, separate
      // from the buffer's internal cap): walk newest→oldest, dropping events
      // older than the overflow point while always keeping the last event.
      //
      // Terminal records are NOT removed here. The exit watcher and the
      // stdout/stderr capture fibers complete independently, so the child's
      // `exitCode` resolving does not guarantee the capture fibers have
      // finished draining the OS pipe. Deleting the record on the first poll
      // that observes a terminal state could interrupt an in-flight capture
      // fiber and drop the command's final output. Instead, terminal records
      // stay readable by handle (and hidden from `list`, which is live-only)
      // until the 30-minute TTL purge removes them.
      const build = (latest: Record, waitStatus: PollWaitStatus): PollResponse => {
        const { events, nextCursor, truncatedBeforeCursor } = latest.buffer.since(cursor)
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
          info: snapshot(latest),
          events: trimmed,
          nextCursor: trimmed.length === 0 ? nextCursor : trimmed[trimmed.length - 1]!.seq,
          truncatedBeforeCursor: truncatedBeforeCursor || start > 0,
          waitStatus,
        }
      }

      // Resolve the freshest record and classify it against the cursor. Output
      // is preferred over terminal when both are observable in the same read.
      const observe = Effect.fnUntraced(function* () {
        const latest = (yield* lookup(input.handle, input.sessionID)) ?? rec
        const hasOutput = latest.buffer.since(cursor).events.length > 0
        return { latest, hasOutput, terminal: isTerminal(latest) } as const
      })

      // Immediate poll: never block, just report the current view. `wait_ms`
      // of 0 (or omitted) returns "immediate" regardless of output/terminal.
      if (waitMs === 0) {
        const { latest } = yield* observe()
        return build(latest, "immediate")
      }

      // Long poll: return as soon as new output arrives, the process reaches a
      // terminal state, or the wait window elapses. We park on the notifier's
      // deferred rather than sleeping, so output/terminal wakes return early.
      const deadline = now + waitMs
      while (true) {
        // Capture the wake channel before re-reading so a concurrent
        // append/terminal cannot slip between the read and the await.
        const waiter = notifier.deferred
        const first = yield* observe()
        if (first.hasOutput) return build(first.latest, "output")
        if (first.terminal) return build(first.latest, "terminal")

        const remaining = deadline - (yield* Clock.currentTimeMillis)
        if (remaining <= 0) return build(first.latest, "timeout")

        const woke = yield* Deferred.await(waiter).pipe(Effect.timeoutOption(`${remaining} millis`))
        if (Option.isNone(woke)) {
          // Deadline elapsed while parked. Re-read once more so output/terminal
          // that landed exactly at the boundary still wins over "timeout".
          const final = yield* observe()
          if (final.hasOutput) return build(final.latest, "output")
          if (final.terminal) return build(final.latest, "terminal")
          return build(final.latest, "timeout")
        }
        // Woke on output/terminal — loop to re-read and classify.
      }
    })

    const feed: ProcessManagerService["feed"] = Effect.fn("ProcessManager.feed")(function* (input) {
      const rec = yield* lookup(input.handle, input.sessionID)
      if (!rec) return false
      rec.buffer.append(input.kind, input.text, Date.now())
      yield* wakeNotifier(rec.pollNotifier, "output")
      return true
    })

    const stop: ProcessManagerService["stop"] = Effect.fn("ProcessManager.stop")(function* (input) {
      const rec = yield* lookup(input.handle, input.sessionID)
      if (!rec) return yield* failWith("NotFound", `process ${input.handle} not found`, input.handle)
      const now = yield* Clock.currentTimeMillis
      yield* mutate(input.handle, (cur) => ({ ...cur, lastUsedAt: now }))
      if (rec.state === "exited" || rec.state === "failed" || rec.state === "stopped") {
        return snapshot((yield* lookup(input.handle, input.sessionID)) ?? rec)
      }

      // Mark `stopping` first so the exit watcher doesn't race us into
      // `failed` for a clean signal-driven exit, and so the timeout watcher
      // becomes a no-op (it checks `stopping` too).
      yield* mutate(input.handle, (cur) => ({ ...cur, stopping: true }))

      // Interrupt the timeout watcher so it doesn't try to terminate after
      // the caller already issued a stop.
      const after = yield* lookup(input.handle, input.sessionID)
      if (after?.timeoutWatcher) {
        yield* Fiber.interrupt(after.timeoutWatcher).pipe(Effect.ignore)
      }

      const updated = after ?? rec
      if (updated.pid === null) {
        // No pid -> no signal we can send. Flip state directly.
        const endedAt = yield* Clock.currentTimeMillis
        const next = yield* mutate(input.handle, (cur) => ({
          ...cur,
          state: "stopped",
          endedAt,
          exitCode: null,
          signal: null,
          terminationReason: "stopped",
          stopping: true,
        }))
        if (next) {
          yield* closeOwnedScope(next)
          yield* wakeNotifier(next.pollNotifier, "terminal")
          void Deferred.succeed(updated.onExit, { exitCode: null, signal: null })
        }
        return snapshot(next ?? { ...updated, state: "stopped", endedAt, exitCode: null, signal: null, terminationReason: "stopped" })
      }

      yield* adapter.stop({ pid: updated.pid, graceMs: 200 })
      const endedAt = yield* Clock.currentTimeMillis
      const final = yield* mutate(input.handle, (cur) => ({
        ...cur,
        state: "stopped",
        endedAt,
        exitCode: cur.exitCode,
        signal: cur.signal,
        terminationReason: "stopped",
        stopping: true,
      }))
      if (final) {
        yield* closeOwnedScope(final)
        yield* wakeNotifier(final.pollNotifier, "terminal")
        void Deferred.succeed(updated.onExit, { exitCode: final.exitCode, signal: final.signal })
      }
      return snapshot(final ?? { ...updated, state: "stopped", endedAt, exitCode: updated.exitCode, signal: updated.signal, terminationReason: "stopped", stopping: true })
    })

    const killAllForSession: ProcessManagerService["killAllForSession"] = Effect.fn(
      "ProcessManager.killAllForSession",
    )(function* (sessionID) {
      const map = yield* SynchronizedRef.get(yield* recordsRef())
      const targets = Array.from(map.values()).filter(
        (rec) =>
          rec.ownerSessionID === sessionID &&
          (rec.state === "running" || rec.state === "starting") &&
          rec.pid !== null,
      )
      for (const rec of targets) {
        // Mark `stopping` and flip state to `stopped` synchronously inside
        // the manager — `killAllForSession` is a sweep, not a per-process
        // wait, so we want the record's state to update immediately. The
        // adapter.stop call is best-effort and may take up to `graceMs`.
        yield* mutate(rec.handle, (cur) => ({
          ...cur,
          stopping: true,
        }))
        const fresh = (yield* lookup(rec.handle, sessionID)) ?? rec
        if (fresh.timeoutWatcher) yield* Fiber.interrupt(fresh.timeoutWatcher).pipe(Effect.ignore)
        if (fresh.pid !== null) {
          yield* adapter.stop({ pid: fresh.pid, graceMs: 200 }).pipe(Effect.ignore)
        }
        const endedAt = yield* Clock.currentTimeMillis
        const next = yield* mutate(rec.handle, (cur) => ({
          ...cur,
          state: "stopped",
          endedAt,
          exitCode: cur.exitCode,
          signal: cur.signal,
          terminationReason: "stopped",
        }))
        if (next) {
          yield* closeOwnedScope(next)
          yield* wakeNotifier(next.pollNotifier, "terminal")
          void Deferred.succeed(next.onExit, { exitCode: next.exitCode, signal: next.signal })
        }
      }
    })

    const killAll: ProcessManagerService["killAll"] = Effect.fn("ProcessManager.killAll")(function* () {
      const map = yield* SynchronizedRef.get(yield* recordsRef())
      const targets = Array.from(map.values()).filter(
        (rec) => (rec.state === "running" || rec.state === "starting") && rec.pid !== null,
      )
      for (const rec of targets) {
        yield* mutate(rec.handle, (cur) => ({ ...cur, stopping: true }))
        const fresh = (yield* lookup(rec.handle, rec.ownerSessionID)) ?? rec
        if (fresh.timeoutWatcher) yield* Fiber.interrupt(fresh.timeoutWatcher).pipe(Effect.ignore)
        if (fresh.pid !== null) {
          yield* adapter.stop({ pid: fresh.pid, graceMs: 200 }).pipe(Effect.ignore)
        }
        const endedAt = yield* Clock.currentTimeMillis
        const next = yield* mutate(rec.handle, (cur) => ({
          ...cur,
          state: "stopped",
          endedAt,
          exitCode: cur.exitCode,
          signal: cur.signal,
          terminationReason: "stopped",
        }))
        if (next) {
          yield* closeOwnedScope(next)
          yield* wakeNotifier(next.pollNotifier, "terminal")
          void Deferred.succeed(next.onExit, { exitCode: next.exitCode, signal: next.signal })
        }
      }
    })

    const purgeExpired: ProcessManagerService["purgeExpired"] = Effect.fn("ProcessManager.purgeExpired")(
      function* () {
        const now = yield* Clock.currentTimeMillis
        yield* SynchronizedRef.modify(yield* recordsRef(), (m) => {
          let changed = false
          const next = new Map(m)
          for (const [key, rec] of m) {
            // Only purge records that are terminal AND whose caller-owned
            // scope (if any) has been released. This is currently the same
            // condition as `endedAt !== null` because every terminal
            // transition closes the scope, but the explicit check guards
            // against future code that decouples the two states.
            const isTerminal = rec.endedAt !== null
            const scopeIsClosed = !rec.ownedRelease || rec.ownedScopeClosed
            if (isTerminal && scopeIsClosed && now - rec.endedAt! >= TTL_MS) {
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

    return Service.of({ promote, list, info, poll, feed, stop, killAllForSession, killAll, purgeExpired })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Layer.succeed(ProcessAdapter)(liveProcessAdapter)),
)

export * as ProcessManager from "./service"

import { Cause, Deferred, Effect, Exit, Fiber, Latch, Schema, Scope, SynchronizedRef } from "effect"

export interface Runner<A, E = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  readonly ensureRunning: (work: Effect.Effect<A, E>) => Effect.Effect<A, E>
  /**
   * Atomically claim the runner for an exclusive detached run. If the
   * runner is Idle, the work is forked into the runner scope (exactly
   * like `ensureRunning`'s Idle branch) and the runner transitions to
   * `Running`; returns `true` without awaiting completion. If the runner
   * is in any non-Idle state, the work is NOT started and `false` is
   * returned. This is the claim-or-fail primitive for detached exclusive
   * runs: unlike `ensureRunning` it never joins an in-flight run, so a
   * concurrent normal prompt/retry/shell deterministically loses the race
   * instead of silently attaching to the existing run.
   */
  readonly tryStart: (work: Effect.Effect<A, E>) => Effect.Effect<boolean>
  readonly startShell: (work: Effect.Effect<A, E>, ready?: Latch.Latch) => Effect.Effect<A, E | Busy>
  readonly cancel: Effect.Effect<void>
}

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("RunnerCancelled", {}) {}
export class Busy extends Schema.TaggedErrorClass<Busy>()("RunnerBusy", {}) {}

interface RunHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  fiber: Fiber.Fiber<A, E>
}

interface ShellHandle<A, E> {
  id: number
  cancelled: Deferred.Deferred<void>
  ready?: Latch.Latch
  fiber: Fiber.Fiber<A, E>
}

interface PendingHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  work: Effect.Effect<A, E>
}

export type State<A, E> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly run: RunHandle<A, E> }
  | { readonly _tag: "Shell"; readonly shell: ShellHandle<A, E> }
  | { readonly _tag: "ShellThenRun"; readonly shell: ShellHandle<A, E>; readonly run: PendingHandle<A, E> }

export const make = <A, E = never>(
  scope: Scope.Scope,
  opts?: {
    onIdle?: Effect.Effect<void>
    onBusy?: Effect.Effect<void>
    onInterrupt?: Effect.Effect<A, E>
  },
): Runner<A, E> => {
  const ref = SynchronizedRef.makeUnsafe<State<A, E>>({ _tag: "Idle" })
  const idle = opts?.onIdle ?? Effect.void
  const onBusy = opts?.onBusy ?? Effect.void
  const onInterrupt = opts?.onInterrupt
  let ids = 0

  const state = () => SynchronizedRef.getUnsafe(ref)
  const next = () => {
    ids += 1
    return ids
  }

  const complete = (done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Deferred.fail(done, new Cancelled()).pipe(Effect.asVoid)
      : Deferred.done(done, exit).pipe(Effect.asVoid)

  const awaitDone = (done: Deferred.Deferred<A, E | Cancelled>) =>
    Deferred.await(done).pipe(Effect.catchTag("RunnerCancelled", (e) => onInterrupt ?? Effect.die(e)))

  const idleIfCurrent = () =>
    SynchronizedRef.modify(ref, (st) => [st._tag === "Idle" ? idle : Effect.void, st] as const).pipe(Effect.flatten)

  const finishRun = (id: number, done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>) =>
    SynchronizedRef.modify(
      ref,
      (st) =>
        [
          Effect.gen(function* () {
            if (st._tag === "Running" && st.run.id === id) yield* idle
            yield* complete(done, exit)
          }),
          st._tag === "Running" && st.run.id === id ? ({ _tag: "Idle" } as const) : st,
        ] as const,
    ).pipe(Effect.flatten)

  const startRun = (work: Effect.Effect<A, E>, done: Deferred.Deferred<A, E | Cancelled>) =>
    Effect.gen(function* () {
      const id = next()
      const fiber = yield* work.pipe(
        Effect.onExit((exit) => finishRun(id, done, exit)),
        Effect.forkIn(scope),
      )
      return { id, done, fiber } satisfies RunHandle<A, E>
    })

  const finishShell = (id: number) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag === "Shell" && st.shell.id === id) {
          return [idle, { _tag: "Idle" }] as const
        }
        if (st._tag === "ShellThenRun" && st.shell.id === id) {
          const run = yield* startRun(st.run.work, st.run.done)
          return [Effect.void, { _tag: "Running", run }] as const
        }
        return [Effect.void, st] as const
      }),
    ).pipe(Effect.flatten)

  const stopShell = (shell: ShellHandle<A, E>) =>
    Effect.gen(function* () {
      if (shell.ready) yield* shell.ready.await.pipe(Effect.exit, Effect.asVoid)
      yield* Deferred.succeed(shell.cancelled, undefined).pipe(Effect.asVoid)
      yield* Fiber.interrupt(shell.fiber)
    })

  const interruptRun = (fiber: Fiber.Fiber<A, E>) =>
    Fiber.interrupt(fiber).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)

  const ensureRunning = (work: Effect.Effect<A, E>) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        switch (st._tag) {
          case "Running":
          case "ShellThenRun":
            return [awaitDone(st.run.done), st] as const
          case "Shell": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled>(),
              work,
            } satisfies PendingHandle<A, E>
            return [awaitDone(run.done), { _tag: "ShellThenRun", shell: st.shell, run }] as const
          }
          case "Idle": {
            const done = yield* Deferred.make<A, E | Cancelled>()
            const run = yield* startRun(work, done)
            return [awaitDone(done), { _tag: "Running", run }] as const
          }
        }
      }),
    ).pipe(Effect.flatten)

  const tryStart = (work: Effect.Effect<A, E>): Effect.Effect<boolean> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") return [Effect.succeed(false), st] as const
        const done = yield* Deferred.make<A, E | Cancelled>()
        const run = yield* startRun(work, done)
        return [Effect.succeed(true), { _tag: "Running", run }] as const
      }),
    ).pipe(Effect.flatten)

  const startShell = (work: Effect.Effect<A, E>, ready?: Latch.Latch): Effect.Effect<A, E | Busy> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") {
          const reject: Effect.Effect<A, E | Busy> = Effect.fail(new Busy())
          return [reject, st] as const
        }
        yield* onBusy
        const id = next()
        const cancelled = yield* Deferred.make<void>()
        const fiber = yield* work.pipe(Effect.ensuring(finishShell(id)), Effect.forkChild)
        const shell = { id, cancelled, ready, fiber } satisfies ShellHandle<A, E>
        return [
          Effect.gen(function* () {
            const exit = yield* Fiber.await(fiber)
            if (Exit.isSuccess(exit)) return exit.value
            if (
              Cause.hasInterruptsOnly(exit.cause) ||
              ((yield* Deferred.isDone(cancelled)) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause))
            ) {
              if (onInterrupt) return yield* onInterrupt
              return yield* Effect.die(new Cancelled())
            }
            return yield* Effect.failCause(exit.cause)
          }),
          { _tag: "Shell", shell },
        ] as const
      }),
    ).pipe(Effect.flatten)

  const cancel = SynchronizedRef.modify(ref, (st) => {
    switch (st._tag) {
      case "Idle":
        return [Effect.void, st] as const
      case "Running":
        return [
          Effect.gen(function* () {
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* interruptRun(st.run.fiber)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "Shell":
        return [
          Effect.gen(function* () {
            yield* stopShell(st.shell)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
      case "ShellThenRun":
        return [
          Effect.gen(function* () {
            yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
            yield* stopShell(st.shell)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
    }
  }).pipe(Effect.flatten)

  return {
    get state() {
      return state()
    },
    get busy() {
      return state()._tag !== "Idle"
    },
    ensureRunning,
    tryStart,
    startShell,
    cancel,
  }
}

export * as Runner from "./runner"

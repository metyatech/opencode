import { Effect, Schema } from "effect"

import { ProcessHandle } from "./id"

// Lifecycle states a managed process moves through. The shell tool owns the
// "starting" / "running" / "exited" path; the process manager flips "running"
// to "stopped" / "failed" when the caller terminates the process or the
// adapter fails to terminate it.
export type ProcessState = "starting" | "running" | "exited" | "failed" | "stopped"

export const ProcessStateLiteral = Schema.Literals(["starting", "running", "exited", "failed", "stopped"])

// One captured chunk of process output. `seq` is a monotonic integer assigned
// by the bounded ring buffer at append time; cursors are integers, not bytes.
// `at` is `Date.now()` at append time, captured from the spawner thread.
export class ProcessEvent extends Schema.Class<ProcessEvent>("ProcessEvent")({
  kind: Schema.Literals(["stdout", "stderr"]),
  seq: Schema.Int,
  text: Schema.String,
  at: Schema.Number,
}) {}

// Public snapshot the tool surface exposes. Pure data — no live handles, no
// streams, no Effect. Cross-session callers must observe the same shape but
// receive `undefined` instead of leaking the record (see ProcessManager.info).
export class ProcessInfo extends Schema.Class<ProcessInfo>("ProcessInfo")({
  handle: ProcessHandle,
  command: Schema.String,
  cwd: Schema.String,
  state: ProcessStateLiteral,
  startedAt: Schema.Number,
  endedAt: Schema.optional(Schema.Number),
  exitCode: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  ownerSessionID: Schema.String,
  pid: Schema.NullOr(Schema.Number),
  inputClosed: Schema.Boolean,
  outputClosed: Schema.optional(Schema.Boolean),
  closedAt: Schema.optional(Schema.NullOr(Schema.Number)),
  // Caller-supplied hard deadline (in ms) captured at promote time. `null`
  // when the caller had no timeout in mind (e.g. tests, ad-hoc CLI use).
  // Optional so existing call sites that predate the field can omit it;
  // the manager defaults to `null`.
  timeoutMs: Schema.optional(Schema.NullOr(Schema.Number)),
  // Why the record ended. `null` while still running/starting; `natural` for
  // a clean exit, `stopped` for an explicit `stop`/`killAll`/`killAllForSession`,
  // `timeout` for a hard-deadline-driven termination. Surfaced so poll users
  // can tell apart "child exited cleanly on its own" from "we killed it".
  terminationReason: Schema.optional(Schema.NullOr(Schema.Literals(["timeout", "stopped", "natural"]))),
}) {}

// Domain error for the process manager. `_tag` is the discriminator callers
// match against — keep it in the literal union so Effect's tagged-error
// pattern matching stays exhaustive.
export type ProcessErrorReason =
  | "NotFound"
  | "NotRunning"
  | "StdinClosed"
  | "LimitReached"
  | "AlreadyExited"
  | "Internal"

export class ProcessError extends Schema.TaggedErrorClass<ProcessError>()("ProcessError", {
  reason: Schema.Literals([
    "NotFound",
    "NotRunning",
    "StdinClosed",
    "LimitReached",
    "AlreadyExited",
    "Internal",
  ]),
  handle: Schema.optional(ProcessHandle),
  message: Schema.String,
}) {}

// Minimal shape a managed process exposes to the ProcessManager. Anything
// richer (kill options, stdio streams, exitCode promise) is captured in the
// service record; the manager only needs a few read/write primitives.

// Minimal shape a managed process exposes to the ProcessManager. Anything
// richer (kill options, stdio streams, exitCode promise) is captured in the
// service record; the manager only needs a few read/write primitives.
export type ManagedChild = {
  readonly pid: number | null
  readonly exitCode: Effect.Effect<number, never, never>
  readonly kill: (signal?: NodeJS.Signals) => void
  readonly stdin?: ManagedStdin
}

// stdin is either a writable sink (from the CrossSpawnSpawner) or undefined
// when the process was started with `stdin: "ignore"`.
export type ManagedStdin = {
  readonly write: (chunk: string) => Effect.Effect<void, never, never>
  readonly close: () => Effect.Effect<void, never, never>
}

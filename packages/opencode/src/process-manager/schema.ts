import { Schema } from "effect"

import { NonNegativeInt } from "@opencode-ai/core/schema"

import { ProcessHandle } from "./id"
import { ProcessInfo } from "./types"

// Tool-level action schema. Strict — only the four documented actions are
// accepted. Field names use snake_case so the LLM sees the same shape the
// shell tool already publishes; we convert to camelCase on the way out of
// the manager.

export const ListAction = Schema.Struct({
  action: Schema.Literal("list"),
})

export const PollAction = Schema.Struct({
  action: Schema.Literal("poll"),
  handle: ProcessHandle,
  cursor: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  max_bytes: Schema.optional(NonNegativeInt),
  wait_ms: Schema.optional(NonNegativeInt),
})

export const WriteAction = Schema.Struct({
  action: Schema.Literal("write"),
  handle: ProcessHandle,
  data: Schema.String,
  append_newline: Schema.optional(Schema.Boolean),
})

export const StopAction = Schema.Struct({
  action: Schema.Literal("stop"),
  handle: ProcessHandle,
})

export const Action = Schema.Union([ListAction, PollAction, WriteAction, StopAction])

export type Action = Schema.Schema.Type<typeof Action>

// Result payloads. The tool JSON-serializes these and returns them in
// `output`. `Metadata` carries `{ action, state, handle? }` for tool-level
// telemetry — keep it minimal.

export class PollResult extends Schema.Class<PollResult>("ProcessPollResult")({
  info: ProcessInfo,
  events: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["stdout", "stderr"]),
      seq: Schema.Int,
      text: Schema.String,
      at: Schema.Number,
    }),
  ),
  next_cursor: Schema.Int,
  truncated_before_cursor: Schema.Boolean,
}) {}

export class ListResult extends Schema.Class<ListResult>("ProcessListResult")({
  processes: Schema.Array(ProcessInfo),
}) {}

export class WriteResult extends Schema.Class<WriteResult>("ProcessWriteResult")({
  handle: ProcessHandle,
  state: ProcessInfo.fields.state,
  bytes_written: NonNegativeInt,
}) {}

export class StopResult extends Schema.Class<StopResult>("ProcessStopResult")({
  info: ProcessInfo,
}) {}

// Bound helpers — what the manager actually clamps to internally.
export const POLL_MAX_BYTES_HARD_CAP = 64 * 1024
export const POLL_DEFAULT_MAX_BYTES = 64 * 1024
export const POLL_DEFAULT_WAIT_MS = 0
export const POLL_MAX_WAIT_MS = 5000

// Service-level input shapes. The tool layer translates the snake_case LLM
// fields into these camelCase shapes before crossing into the manager.
export const PollInput = Schema.Struct({
  sessionID: Schema.String,
  handle: ProcessHandle,
  cursor: Schema.optional(Schema.Int),
  maxBytes: Schema.optional(NonNegativeInt),
  waitMs: Schema.optional(NonNegativeInt),
})
export type PollInput = Schema.Schema.Type<typeof PollInput>

export const WriteInput = Schema.Struct({
  sessionID: Schema.String,
  handle: ProcessHandle,
  data: Schema.String,
  appendNewline: Schema.optional(Schema.Boolean),
})
export type WriteInput = Schema.Schema.Type<typeof WriteInput>

export const PromoteInput = Schema.Struct({
  sessionID: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  pid: Schema.NullOr(Schema.Number),
  stdinAvailable: Schema.Boolean,
  child: Schema.Unknown,
  timeoutMs: Schema.optional(Schema.NullOr(Schema.Number)),
  // Optional stdio streams from the live child. When supplied, the manager
  // forks a long-lived capture fiber per stream that drains into the ring
  // buffer. Accept any stream-like shape — the Effect spawner hands back
  // `Stream.Stream<Uint8Array>`, while Bun tests hand back a
  // `ReadableStream<Uint8Array>`. The manager does the right thing
  // internally based on the value's shape. Pass `null` (or omit) to skip
  // manager-owned capture — the spawner can still drive the buffer via
  // `feed(...)` for tests and adapters that prefer that path. Phase 3 wiring
  // (shell tool) passes the live `handle.stdout` and `handle.stderr` streams
  // from the spawner so the manager owns capture after promote.
  stdout: Schema.optional(Schema.NullOr(Schema.Unknown)),
  stderr: Schema.optional(Schema.NullOr(Schema.Unknown)),
})
export type PromoteInput = Schema.Schema.Type<typeof PromoteInput>

// `PollResponse` is the value the manager returns from `poll(...)`. It mirrors
// `PollResult` but uses camelCase for in-process consumption; the tool layer
// JSON-serializes it back to the LLM shape.
export const PollResponse = Schema.Struct({
  info: ProcessInfo,
  events: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["stdout", "stderr"]),
      seq: Schema.Int,
      text: Schema.String,
      at: Schema.Number,
    }),
  ),
  nextCursor: Schema.Int,
  truncatedBeforeCursor: Schema.Boolean,
})
export type PollResponse = Schema.Schema.Type<typeof PollResponse>

import { Effect } from "effect"

import { Action } from "./schema"
import { ProcessManager } from "./service"
import { ProcessError } from "./types"
import * as Tool from "../tool/tool"

// Process tool raw-input normalization. The LLM occasionally emits poll
// numerics as decimal-integer strings (e.g. `"0"` for `cursor`) which the
// strict Effect schema rejects. We coerce ONLY the three documented poll
// numerics, ONLY for the `poll` action, ONLY when the value is an ASCII
// decimal non-negative integer string within the JavaScript safe-integer
// range. Anything else (`""`, `"abc"`, `"1.5"`, `"-1"`, `"0x10"`, `"01"`,
// values past `Number.MAX_SAFE_INTEGER`, non-`poll` actions, non-object
// inputs) is returned unchanged so the existing schema validation handles
// it the same way as before. `list` / `stop` are explicitly not normalized
// — those actions don't carry these fields in the documented shape, and
// silently widening them would mask real caller mistakes.
const PROCESS_POLL_NUMERIC_FIELDS = ["cursor", "wait_ms", "max_bytes"] as const

function parseNonNegativeSafeIntegerString(value: string): number | undefined {
  // ASCII decimal only: reject `""`, `" 1"`, `"1.5"`, `"0x10"`, `"-1"`,
  // `"01"`, and any leading/trailing whitespace. The leading-zero rule
  // (`01`) is strict on purpose — the LLM should send a number, not a
  // zero-padded string.
  if (!/^(0|[1-9]\d*)$/.test(value)) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) return undefined
  return parsed
}

export function normalizeProcessToolArgs(args: unknown): unknown {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args

  const record = args as Record<string, unknown>
  // Normalization is gated on `action === "poll"` so list/stop and any
  // future action are unaffected. A typo'd action (e.g. `"pol"`) reaches
  // the schema decoder unchanged and is rejected there.
  if (record.action !== "poll") return args

  let changed = false
  const normalized: Record<string, unknown> = { ...record }

  for (const key of PROCESS_POLL_NUMERIC_FIELDS) {
    const value = record[key]
    if (typeof value !== "string") continue

    const parsed = parseNonNegativeSafeIntegerString(value)
    if (parsed === undefined) continue

    normalized[key] = parsed
    changed = true
  }

  // Reference-equal return when nothing changed — lets the wrapper's
  // `decode(args)` skip the normalization branch entirely downstream.
  return changed ? normalized : args
}

function errorToResult(action: Metadata["action"], err: unknown, handle?: string): Tool.ExecuteResult<Metadata> {
  const message =
    err instanceof Error
      ? err.message
      : err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message)
        : "process manager error"
  return {
    title: action,
    metadata: { action, state: "failed", ...(handle ? { handle } : {}) },
    output: JSON.stringify({ error: { message, kind: err instanceof ProcessError ? err.reason : "Internal" } }),
  }
}

function asAction(value: string): Metadata["action"] {
  if (value === "list" || value === "poll" || value === "stop") return value
  return "poll"
}

const DESCRIPTION = `Manage long-running background shell processes started by the bash tool when its background_after_ms yield threshold is reached. They are not killed merely because elapsed time passes after yielding. Tool calls are session-scoped: a session can only interact with processes it owns. Handles are opaque tokens, not OS PIDs. The manager keeps up to 64 global processes and prunes older records when full. Use \`list\` to enumerate the session's live processes. Use \`poll\` to fetch new output since a monotonic cursor. Use \`stop\` to terminate a process; idempotent on already-stopped processes.

Never call this tool with empty arguments.
Use exactly one of these argument shapes:

List processes in this session:
{"action":"list"}

Poll output from a background process:
{"action":"poll","handle":"proc_...","cursor":0}

Poll and wait for new output or exit (long poll, up to 300000ms):
{"action":"poll","handle":"proc_...","cursor":0,"wait_ms":300000}

Stop a background process:
{"action":"stop","handle":"proc_..."}

If you need a handle but do not know it, call {"action":"list"} first.

To wait for a long-running command to finish, poll with wait_ms:300000. A poll with wait_ms waits until new output arrives, the process exits, or the wait window elapses (whichever comes first). An omitted wait_ms (or wait_ms:0) returns immediately. On each subsequent poll, pass the previous result's next_cursor as cursor so you only receive new output. The result includes wait_status: "immediate" (returned at once), "output" (new output), "terminal" (process ended), or "timeout". A "timeout" result with info.state "running" is not a failure: the command is still running and the wait window elapsed, so poll again.

There is intentionally no \`write\` action: the bash tool spawns every command with stdin set to "ignore", so no stdin pipe is exposed to backgrounded processes today. Use \`poll\` to observe natural exit and \`stop\` to terminate a live backgrounded process.`

function shortError(error: unknown) {
  const text = String(error)
  return text.length <= 1000 ? text : `${text.slice(0, 1000)}...`
}

function isEmptyObjectArgs(args: unknown): boolean {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return false
  return Object.keys(args as Record<string, unknown>).length === 0
}

function formatProcessValidationError(error: unknown, args?: unknown): string {
  const guidance = isEmptyObjectArgs(args)
    ? [
        "The process tool requires an action and must never be called with empty arguments.",
        "Use exactly one of:",
        '{"action":"list"}',
        '{"action":"poll","handle":"proc_...","cursor":0}',
        '{"action":"stop","handle":"proc_..."}',
        "",
        'If the handle is unknown, call {"action":"list"} first.',
      ]
    : [
        "Invalid process tool arguments. The process tool requires one of list/poll/stop with correctly typed fields. For poll, cursor/wait_ms/max_bytes must be numbers when provided.",
      ]
  return [...guidance, "", `Original schema error: ${shortError(error)}`].join("\n")
}

type Metadata = {
  action: "list" | "poll" | "stop"
  state?: string
  handle?: string
  count?: number
}

export const ProcessTool = Tool.define<typeof Action, Metadata, ProcessManager.Service>(
  "process",
  Effect.gen(function* () {
    const manager = yield* ProcessManager.Service

    return {
      description: DESCRIPTION,
      parameters: Action,
      normalizeInput: normalizeProcessToolArgs,
      formatValidationError: formatProcessValidationError,
      execute: (params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const sessionID = ctx.sessionID as unknown as string
          switch (params.action) {
            case "list": {
              const processes = yield* manager.list({ sessionID })
              const result = { processes }
              return {
                title: "list" as const,
                metadata: { action: "list" as const, count: processes.length },
                output: JSON.stringify(result),
              }
            }
            case "poll": {
              const result = yield* manager.poll({
                sessionID,
                handle: params.handle,
                cursor: params.cursor,
                maxBytes: params.max_bytes,
                waitMs: params.wait_ms,
              })
              if (result === undefined) {
                return errorToResult("poll", {
                  message: "process not found or not owned by this session",
                }, params.handle)
              }
              return {
                title: "poll" as const,
                metadata: { action: "poll" as const, state: result.info.state, handle: params.handle },
                output: JSON.stringify({
                  info: result.info,
                  events: result.events,
                  next_cursor: result.nextCursor,
                  truncated_before_cursor: result.truncatedBeforeCursor,
                  wait_status: result.waitStatus,
                }),
              }
            }
            case "stop": {
              const info = yield* manager.stop({ sessionID, handle: params.handle })
              return {
                title: "stop" as const,
                metadata: { action: "stop" as const, state: info.state, handle: params.handle },
                output: JSON.stringify({ info }),
              }
            }
          }
        }).pipe(
          Effect.catch((err) =>
            Effect.succeed(
              errorToResult(
                asAction(params.action),
                err,
                "handle" in params ? params.handle : undefined,
              ),
            ),
          ),
        ),
    } as Tool.DefWithoutID<typeof Action, Metadata>
  }),
)

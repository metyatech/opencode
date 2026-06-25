import { Effect } from "effect"

import { Action } from "./schema"
import { ProcessManager } from "./service"
import { ProcessError } from "./types"
import * as Tool from "../tool/tool"

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

Stop a background process:
{"action":"stop","handle":"proc_..."}

If you need a handle but do not know it, call {"action":"list"} first.

There is intentionally no \`write\` action: the bash tool spawns every command with stdin set to "ignore", so no stdin pipe is exposed to backgrounded processes today. Use \`poll\` to observe natural exit and \`stop\` to terminate a live backgrounded process.`

function shortError(error: unknown) {
  const text = String(error)
  return text.length <= 1000 ? text : `${text.slice(0, 1000)}...`
}

function formatProcessValidationError(error: unknown): string {
  return [
    "The process tool requires an action and must never be called with empty arguments.",
    "Use exactly one of:",
    '{"action":"list"}',
    '{"action":"poll","handle":"proc_...","cursor":0}',
    '{"action":"stop","handle":"proc_..."}',
    "",
    'If the handle is unknown, call {"action":"list"} first.',
    "",
    `Original schema error: ${shortError(error)}`,
  ].join("\n")
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

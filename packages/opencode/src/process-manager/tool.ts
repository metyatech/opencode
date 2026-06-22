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
  if (value === "list" || value === "poll" || value === "stop" || value === "write") return value
  return "poll"
}

const DESCRIPTION = `Manage long-running background shell processes started by the bash tool when its background_after_ms threshold is reached. Actions: list, poll, write, stop. Tool calls are session-scoped: a session can only interact with processes it owns. Handles are opaque tokens, not OS PIDs. Use \`list\` to enumerate the session's processes. Use \`poll\` to fetch new output since a monotonic cursor. Use \`write\` to send a string to a running process's stdin (pass \`append_newline: true\` for line-terminated input). Use \`stop\` to terminate a process; idempotent on already-stopped processes.

NOTE on \`write\`: the bash tool currently spawns every command with stdin set to "ignore", so no stdin pipe is exposed to the process. The \`write\` action is reserved for a future spawner that opens a real stdin pipe; today \`write\` calls return a "process stdin is closed" error. Use \`stop\` (or wait for the natural exit / hard timeout) to terminate backgrounded processes.`

type Metadata = {
  action: "list" | "poll" | "write" | "stop"
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
            case "write": {
              const r = yield* manager.write({
                sessionID,
                handle: params.handle,
                data: params.data,
                appendNewline: params.append_newline ?? false,
              })
              if (r === undefined) {
                return errorToResult("write", {
                  message: "process not found or not owned by this session",
                }, params.handle)
              }
              return {
                title: "write" as const,
                metadata: { action: "write" as const, state: "running" as const, handle: params.handle },
                output: JSON.stringify({ handle: params.handle, bytes_written: r.bytesWritten }),
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

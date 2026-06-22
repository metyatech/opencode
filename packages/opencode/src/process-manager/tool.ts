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

const DESCRIPTION = `Manage long-running background shell processes started by the bash tool when its background_after_ms threshold is reached. Actions: list, poll, stop. Tool calls are session-scoped: a session can only interact with processes it owns. Handles are opaque tokens, not OS PIDs. Use \`list\` to enumerate the session's processes. Use \`poll\` to fetch new output since a monotonic cursor. Use \`stop\` to terminate a process; idempotent on already-stopped processes.

There is intentionally no \`write\` action: the bash tool spawns every command with stdin set to "ignore", so no stdin pipe is exposed to backgrounded processes today. Use \`stop\` (or wait for the natural exit / hard timeout) to terminate a backgrounded process.`

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

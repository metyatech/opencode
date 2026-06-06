import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { Effect, Option } from "effect"
import { MessageV2 } from "./message-v2"
import type { Info } from "./session"
import type { SessionID } from "./schema"

type SessionOps = {
  children: (parentID: SessionID) => Effect.Effect<Info[]>
  findMessage: (
    sessionID: SessionID,
    predicate: (msg: MessageV2.WithParts) => boolean,
  ) => Effect.Effect<Option.Option<MessageV2.WithParts>, unknown>
  updatePart: <T extends MessageV2.Part>(part: T) => Effect.Effect<T>
  updateMessage: <T extends MessageV2.Info>(msg: T) => Effect.Effect<T>
}

type ChildResult = { status: "pending" } | { status: "completed"; text: string } | { status: "error"; error: string }

const TITLE_MATCH_SKEW_MS = 5_000

function output(sessionID: SessionID, text: string) {
  return [`<task id="${sessionID}" state="completed">`, "<task_result>", text, "</task_result>", "</task>"].join("\n")
}

function isTerminalAssistant(msg: MessageV2.WithParts): msg is MessageV2.WithParts & { info: MessageV2.Assistant } {
  return (
    msg.info.role === "assistant" &&
    (msg.info.time.completed !== undefined || msg.info.finish !== undefined || msg.info.error !== undefined)
  )
}

function textResult(parts: MessageV2.Part[]) {
  return parts.findLast((part): part is MessageV2.TextPart => part.type === "text" && part.text.trim().length > 0)?.text
}

function stateMetadata(part: MessageV2.ToolPart) {
  return "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
}

function metadataSessionID(part: MessageV2.ToolPart) {
  const sessionID = stateMetadata(part).sessionId
  if (typeof sessionID === "string") return sessionID
  return undefined
}

function taskTitle(part: MessageV2.ToolPart) {
  if ("title" in part.state && part.state.title) return part.state.title
  const description = part.state.input.description
  if (typeof description === "string" && description.trim()) return description
  return "Task"
}

function taskStart(part: MessageV2.ToolPart) {
  return part.state.status === "running" ? part.state.time.start : 0
}

function matchesTaskTitle(child: Info, title: string) {
  return child.title === title || child.title.startsWith(`${title} (@`)
}

function childForPart(part: MessageV2.ToolPart, children: Info[], used: Set<SessionID>, childSessionID?: SessionID) {
  const sessionID = metadataSessionID(part)
  if (sessionID) {
    const child = children.find((child) => child.id === sessionID && !used.has(child.id))
    if (childSessionID && child?.id !== childSessionID) return undefined
    return child
  }

  const title = taskTitle(part)
  const minCreated = taskStart(part) - TITLE_MATCH_SKEW_MS
  const candidates = children
    .filter((child) => !used.has(child.id) && child.time.created >= minCreated && matchesTaskTitle(child, title))
    .sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
  if (candidates.length !== 1) return undefined
  if (childSessionID && candidates[0]?.id !== childSessionID) return undefined
  return candidates[0]
}

const childResult = Effect.fn("SessionTaskReconciliation.childResult")(function* (ops: SessionOps, child: Info) {
  const latest = yield* ops
    .findMessage(child.id, (item) => item.info.role === "assistant")
    .pipe(Effect.catchCause(() => Effect.succeed(Option.none<MessageV2.WithParts>())))
  if (Option.isNone(latest)) return { status: "pending" as const }

  const msg = latest.value
  if (!isTerminalAssistant(msg)) return { status: "pending" as const }

  const text = textResult(msg.parts)
  if (text) return { status: "completed" as const, text }
  if (msg.info.error)
    return { status: "error" as const, error: `Subagent ${child.id} failed: ${errorMessage(msg.info.error)}` }
  return { status: "error" as const, error: `Subagent ${child.id} completed without a text result.` }
})

export const reconcileTaskToolParts = Effect.fn("SessionTaskReconciliation.reconcileTaskToolParts")(function* (input: {
  sessionID: SessionID
  messages: MessageV2.WithParts[]
  childSessionID?: SessionID
  ops: SessionOps
}) {
  if (
    !input.messages.some((msg) =>
      msg.parts.some(
        (part) =>
          part.type === "tool" &&
          part.tool === "task" &&
          (part.state.status === "pending" || part.state.status === "running"),
      ),
    )
  ) {
    return input.messages
  }

  const children = yield* input.ops.children(input.sessionID)
  if (children.length === 0) return input.messages

  const used = new Set<SessionID>()
  const parts = new Map<string, MessageV2.ToolPart>()
  const messages = new Map<string, MessageV2.Assistant>()

  for (const msg of input.messages) {
    if (msg.info.role !== "assistant") continue

    for (const part of msg.parts) {
      if (part.type !== "tool" || part.tool !== "task") continue
      if (part.state.status !== "pending" && part.state.status !== "running") continue

      const child = childForPart(part, children, used, input.childSessionID)
      if (!child) continue

      const result: ChildResult = yield* childResult(input.ops, child)
      if (result.status === "pending") continue

      used.add(child.id)
      const now = Date.now()
      const metadata = { ...stateMetadata(part), parentSessionId: input.sessionID, sessionId: child.id }
      const start = taskStart(part) || child.time.created
      const updated: MessageV2.ToolPart =
        result.status === "completed"
          ? yield* input.ops.updatePart({
              ...part,
              state: {
                status: "completed",
                input: part.state.input,
                title: taskTitle(part),
                metadata,
                output: output(child.id, result.text),
                time: { start, end: now },
              },
            } satisfies MessageV2.ToolPart)
          : yield* input.ops.updatePart({
              ...part,
              state: {
                status: "error",
                input: part.state.input,
                error: result.error,
                metadata,
                time: { start, end: now },
              },
            } satisfies MessageV2.ToolPart)
      parts.set(part.id, updated)

      if (!msg.info.finish && !msg.info.error) {
        messages.set(
          msg.info.id,
          yield* input.ops.updateMessage({
            ...msg.info,
            finish: "tool-calls",
            time: { ...msg.info.time, completed: msg.info.time.completed ?? now },
          }),
        )
      }
    }
  }

  if (parts.size === 0 && messages.size === 0) return input.messages
  return input.messages.map((msg) => ({
    info: messages.get(msg.info.id) ?? msg.info,
    parts: msg.parts.map((part) => parts.get(part.id) ?? part),
  }))
})

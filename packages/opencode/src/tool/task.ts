import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Cause, Duration, Effect, Exit, Option, Schema, Scope, Stream } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { isRecord } from "@/util/record"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  loop(input: SessionPrompt.LoopInput): Effect.Effect<MessageV2.WithParts>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "",
  "",
  [
    "Background mode: background=true launches the subagent asynchronously and returns immediately.",
    "Foreground is the default; use it when you need the result before continuing.",
    "Use background only for independent work that can run while you continue elsewhere.",
    "You will be notified automatically when it finishes.",
  ].join(" "),
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description: "Run the agent in the background. You will be notified when it completes.",
  }),
})

function output(sessionID: SessionID, text: string) {
  return [`<task id="${sessionID}" state="completed">`, "<task_result>", text, "</task_result>", "</task>"].join("\n")
}

function backgroundOutput(sessionID: SessionID) {
  return [
    `<task id="${sessionID}" state="running">`,
    "<summary>Background task started</summary>",
    "<task_result>",
    "Background task started. You will be notified automatically when it finishes; do not poll for progress.",
    "Do not duplicate its work. Continue only with non-overlapping work, or stop if there is nothing else useful to do.",
    "</task_result>",
    "</task>",
  ].join("\n")
}

function isNonEmptyTextPart(part: MessageV2.Part): part is MessageV2.TextPart {
  return part.type === "text" && part.text.trim().length > 0
}

function textResult(parts: MessageV2.Part[]) {
  return parts.findLast(isNonEmptyTextPart)?.text
}

function isTerminalAssistant(msg: MessageV2.WithParts): msg is MessageV2.WithParts & { info: MessageV2.Assistant } {
  return (
    msg.info.role === "assistant" &&
    (msg.info.time.completed !== undefined || msg.info.finish !== undefined || msg.info.error !== undefined)
  )
}

const CHILD_RESULT_SETTLE_ATTEMPTS = 4
const CHILD_RESULT_SETTLE_WAIT: Duration.Input = "500 millis"

function backgroundMessage(input: {
  sessionID: SessionID
  description: string
  state: "completed" | "error"
  text: string
}) {
  const tag = input.state === "completed" ? "task_result" : "task_error"
  const title =
    input.state === "completed"
      ? `Background task completed: ${input.description}`
      : `Background task failed: ${input.description}`
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    `<summary>${title}</summary>`,
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  if (isRecord(error)) {
    const data = error.data
    if (isRecord(data)) {
      const message = data.message
      if (typeof message === "string") return message
    }
    if (typeof error.message === "string") return error.message
    try {
      return JSON.stringify(error)
    } catch {
      return "Unknown object error"
    }
  }
  return String(error)
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const session = params.task_id
        ? yield* sessions
            .get(SessionID.make(params.task_id))
            .pipe(Effect.catchTag("NotFoundError", () => Effect.fail(new Error(`Task not found: ${params.task_id}`))))
        : undefined
      if (params.task_id && session) {
        if (session.id === ctx.sessionID) {
          return yield* Effect.fail(new Error("Cannot resume the current session as a task"))
        }
        if (session.parentID === undefined) {
          return yield* Effect.fail(new Error("Cannot resume a top-level session as a task"))
        }
        if (session.parentID !== ctx.sessionID) {
          return yield* Effect.fail(new Error("Cannot resume task from a different parent session"))
        }
        if (session.agent && session.agent !== params.subagent_type) {
          return yield* Effect.fail(
            new Error(`Session was created with agent '${session.agent}', not '${params.subagent_type}'`),
          )
        }
      }
      const parent = yield* sessions.get(ctx.sessionID)
      const parentAgent = parent.agent
        ? yield* agent.get(parent.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          permission: [
            ...deriveSubagentSessionPermission({
              parentSessionPermission: parent.permission ?? [],
              parentAgent,
              subagent: next,
            }),
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
          ],
        }))

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(Effect.orDie)
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const parentModel = {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const latestChildResult = Effect.fn("TaskTool.latestChildResult")(function* () {
        const latest = yield* sessions
          .findMessage(nextSession.id, (item) => item.info.role === "assistant")
          .pipe(Effect.catchCause(() => Effect.succeed(Option.none<MessageV2.WithParts>())))
        if (Option.isNone(latest)) return { status: "pending" as const }

        const msg = latest.value
        if (!isTerminalAssistant(msg)) return { status: "pending" as const }

        const text = textResult(msg.parts)
        if (text) return { status: "completed" as const, text }

        if (msg.info.error) {
          return {
            status: "error" as const,
            error: new Error(`Subagent ${nextSession.id} failed: ${errorText(msg.info.error)}`),
          }
        }

        return {
          status: "error" as const,
          error: new Error(`Subagent ${nextSession.id} completed without a text result.`),
        }
      })

      const waitForChildEvent = Effect.fn("TaskTool.waitForChildEvent")(function* (input?: {
        timeout?: Duration.Input
        onlyIfActive?: boolean
      }) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* bus.subscribeAll()
            if (input?.onlyIfActive) {
              const current = yield* status.get(nextSession.id)
              if (current.type === "idle") return false
            }
            const wait = stream.pipe(
              Stream.filter((event) => {
                if (!isRecord(event.properties) || event.properties.sessionID !== nextSession.id) return false
                return (
                  event.type === SessionStatus.Event.Status.type ||
                  event.type === SessionStatus.Event.Idle.type ||
                  event.type === MessageV2.Event.Updated.type ||
                  event.type === MessageV2.Event.PartUpdated.type
                )
              }),
              Stream.take(1),
              Stream.runDrain,
            )
            if (!input?.timeout) {
              yield* wait
              return true
            }
            return Option.isSome(yield* wait.pipe(Effect.timeoutOption(input.timeout)))
          }),
        )
      })

      const awaitChildResult: (attempts?: number) => Effect.Effect<string, Error> = Effect.fn(
        "TaskTool.awaitChildResult",
      )(function* (attempts = 0) {
        const result = yield* latestChildResult()
        if (result.status === "completed") return result.text

        if (yield* waitForChildEvent({ onlyIfActive: true })) {
          return yield* awaitChildResult(0)
        }

        if (attempts < CHILD_RESULT_SETTLE_ATTEMPTS) {
          if (yield* waitForChildEvent({ timeout: CHILD_RESULT_SETTLE_WAIT })) {
            return yield* awaitChildResult(attempts + 1)
          }
        }

        if (result.status === "error") return yield* Effect.fail(result.error)
        return yield* Effect.fail(new Error(`Subagent ${nextSession.id} completed without a text result.`))
      })

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          agent: next.name,
          tools: {
            ...(next.permission.some((rule) => rule.permission === "todowrite") ? {} : { todowrite: false }),
            ...(next.permission.some((rule) => rule.permission === id) ? {} : { task: false }),
            ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
          },
          parts,
        })
        return textResult(result.parts) ?? (yield* awaitChildResult())
      })

      const resumeParent: (input: { userID: MessageID; attempts?: number }) => Effect.Effect<void> = Effect.fn(
        "TaskTool.resumeParent",
      )(function* (input) {
        if ((yield* status.get(ctx.sessionID)).type !== "idle") {
          if ((input.attempts ?? 0) >= 60) return
          const stream = yield* Scope.provide(scope)(bus.subscribe(SessionStatus.Event.Idle))
          yield* stream.pipe(
            Stream.filter((event) => event.properties.sessionID === ctx.sessionID),
            Stream.take(1),
            Stream.runDrain,
            Effect.timeoutOption("1 second"),
          )
          yield* resumeParent({ ...input, attempts: (input.attempts ?? 0) + 1 })
          return
        }

        const latest = yield* sessions
          .findMessage(ctx.sessionID, (item) => item.info.role === "user")
          .pipe(Effect.catchCause(() => Effect.succeed(Option.none<MessageV2.WithParts>())))
        if (Option.isNone(latest)) return
        if (latest.value.info.id !== input.userID) return
        yield* ops.loop({ sessionID: ctx.sessionID }).pipe(Effect.ignore)
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        const message = yield* ops.prompt({
          sessionID: ctx.sessionID,
          noReply: true,
          model: parentModel,
          agent: currentParent.agent ?? ctx.agent,
          parts: [
            {
              type: "text",
              synthetic: true,
              text: backgroundMessage({
                sessionID: nextSession.id,
                description: params.description,
                state,
                text,
              }),
            },
          ],
        })
        yield* resumeParent({ userID: message.info.id }).pipe(
          Effect.ignore,
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      const existing = yield* background.get(nextSession.id)
      if (existing?.status === "running") {
        return yield* Effect.fail(new Error(`Task ${nextSession.id} is already running.`))
      }

      if (runInBackground) {
        const info = yield* background.start({
          id: nextSession.id,
          type: id,
          title: params.description,
          metadata,
          run: runTask().pipe(
            Effect.tap((text) => inject("completed", text).pipe(Effect.ignore)),
            Effect.catchCause((cause) =>
              (Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : inject("error", errorText(Cause.squash(cause))).pipe(Effect.ignore)
              ).pipe(Effect.andThen(Effect.failCause(cause))),
            ),
          ),
        })

        return {
          title: params.description,
          metadata: {
            ...metadata,
            jobId: info.id,
          },
          output: backgroundOutput(nextSession.id),
        }
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const text = yield* runTask()
            return {
              title: params.description,
              metadata,
              output: output(nextSession.id, text),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit)) yield* cancel
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents ? DESCRIPTION + BACKGROUND_DESCRIPTION : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

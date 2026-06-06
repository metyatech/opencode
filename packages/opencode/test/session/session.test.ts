import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Layer, Option } from "effect"
import { Session as SessionNs } from "@/session/session"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import * as Log from "@opencode-ai/core/util/log"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { reconcileTaskToolParts } from "../../src/session/task-reconciliation"
import { ProjectID } from "../../src/project/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"

void Log.init({ print: false })

const it = testEffect(
  Layer.mergeAll(
    SessionNs.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(SyncEvent.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    CrossSpawnSpawner.defaultLayer,
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)

const subscribeGlobal = (type: string, callback: (event: NonNullable<GlobalEvent["payload"]>) => void) => {
  const listener = (event: GlobalEvent) => {
    if (event.payload?.type === type) callback(event.payload)
  }
  GlobalBus.on("event", listener)
  return () => GlobalBus.off("event", listener)
}

describe("session.created event", () => {
  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = subscribeGlobal(SessionNs.Event.Created.type, (event) => {
        Deferred.doneUnsafe(received, Effect.succeed(event.properties.info as SessionNs.Info))
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsub))

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubCreated = subscribeGlobal(SessionNs.Event.Created.type, () => {
        push("created")
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsubCreated))

      const unsubUpdated = subscribeGlobal(SessionNs.Event.Updated.type, () => {
        push("updated")
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsubUpdated))

      const info = yield* session.create({})
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )
})

describe("step-finish token propagation via Bus event", () => {
  it.instance(
    "non-zero tokens propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const info = yield* session.create({})

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as MessageV2.Info)

        // Bus subscribers receive readonly Schema.Type payloads; `MessageV2.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<MessageV2.Part>()
        const unsub = subscribeGlobal(MessageV2.Event.PartUpdated.type, (event) => {
          Deferred.doneUnsafe(received, Effect.succeed(event.properties.part as MessageV2.Part))
        })
        yield* Effect.addFinalizer(() => Effect.sync(unsub))

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as MessageV2.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(receivedPart).not.toBe(partInput)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("task tool reconciliation", () => {
  const parentID = SessionID.make("ses_parent")
  const projectID = ProjectID.make("project-task-reconcile")
  const providerID = ProviderID.make("test")
  const modelID = ModelID.make("test")

  const child = (id: string, title: string, created: number) =>
    ({
      id: SessionID.make(id),
      slug: id,
      projectID,
      directory: "/tmp",
      parentID,
      title,
      version: "test",
      time: { created, updated: created },
    }) satisfies SessionNs.Info

  const completedChildMessage = (sessionID: SessionIDType, text: string): MessageV2.WithParts => {
    const messageID = MessageID.ascending()
    return {
      info: {
        id: messageID,
        role: "assistant",
        sessionID,
        parentID: MessageID.ascending(),
        mode: "general",
        agent: "general",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID,
        providerID,
        time: { created: 1, completed: 2 },
        finish: "stop",
      } satisfies MessageV2.Assistant,
      parts: [
        {
          id: PartID.ascending(),
          messageID,
          sessionID,
          type: "text",
          text,
        } satisfies MessageV2.TextPart,
      ],
    }
  }

  const runningTaskMessage = (input: {
    description: string
    start: number
    metadata?: Record<string, unknown>
  }): MessageV2.WithParts => {
    const messageID = MessageID.ascending()
    return {
      info: {
        id: messageID,
        role: "assistant",
        sessionID: parentID,
        parentID: MessageID.ascending(),
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID,
        providerID,
        time: { created: input.start },
      } satisfies MessageV2.Assistant,
      parts: [
        {
          id: PartID.ascending(),
          messageID,
          sessionID: parentID,
          type: "tool",
          callID: "call_task",
          tool: "task",
          state: {
            status: "running",
            input: {
              description: input.description,
              prompt: "do the task",
              subagent_type: "general",
            },
            metadata: input.metadata,
            time: { start: input.start },
          },
        } satisfies MessageV2.ToolPart,
      ],
    }
  }

  const runReconcile = (input: {
    messages: MessageV2.WithParts[]
    children: SessionNs.Info[]
    childMessages: Map<SessionIDType, MessageV2.WithParts>
    updatedParts?: MessageV2.Part[]
    updatedMessages?: MessageV2.Info[]
  }) => {
    const updatedParts = input.updatedParts ?? []
    const updatedMessages = input.updatedMessages ?? []
    return reconcileTaskToolParts({
      sessionID: parentID,
      messages: input.messages,
      ops: {
        children: () => Effect.succeed(input.children),
        findMessage: (sessionID, predicate) => {
          const msg = input.childMessages.get(sessionID)
          return Effect.succeed(msg && predicate(msg) ? Option.some(msg) : Option.none<MessageV2.WithParts>())
        },
        updatePart: <T extends MessageV2.Part>(part: T) =>
          Effect.sync(() => {
            updatedParts.push(part)
            return part
          }),
        updateMessage: <T extends MessageV2.Info>(msg: T) =>
          Effect.sync(() => {
            updatedMessages.push(msg)
            return msg
          }),
      },
    })
  }

  const taskPart = (part: MessageV2.Part | undefined): MessageV2.ToolPart | undefined => {
    return part?.type === "tool" ? part : undefined
  }

  test("uses metadata.sessionId exactly even when multiple children share the task title", async () => {
    const exact = child("ses_exact", "Plan next exercise page (@general subagent)", 1_100)
    const other = child("ses_other", "Plan next exercise page (@general subagent)", 1_050)
    const message = runningTaskMessage({
      description: "Plan next exercise page",
      start: 1_000,
      metadata: { sessionId: exact.id },
    })
    const updatedParts: MessageV2.Part[] = []

    const result = await Effect.runPromise(
      runReconcile({
        messages: [message],
        children: [other, exact],
        childMessages: new Map([
          [other.id, completedChildMessage(other.id, "wrong child completed")],
          [exact.id, completedChildMessage(exact.id, "exact child completed")],
        ]),
        updatedParts,
      }),
    )
    const reconciled = taskPart(result[0]?.parts[0])

    expect(updatedParts).toHaveLength(1)
    expect(reconciled?.state.status).toBe("completed")
    if (reconciled?.state.status === "completed") {
      expect(reconciled.state.metadata.sessionId).toBe(exact.id)
      expect(reconciled.state.output).toContain("exact child completed")
      expect(reconciled.state.output).not.toContain("wrong child completed")
    }
  })

  test("leaves a running task unresolved when title/time fallback has multiple child candidates", async () => {
    const first = child("ses_first", "Plan next exercise page (@general subagent)", 1_050)
    const second = child("ses_second", "Plan next exercise page (@general subagent)", 1_060)
    const message = runningTaskMessage({ description: "Plan next exercise page", start: 1_000 })
    const updatedParts: MessageV2.Part[] = []

    const result = await Effect.runPromise(
      runReconcile({
        messages: [message],
        children: [first, second],
        childMessages: new Map([
          [first.id, completedChildMessage(first.id, "first child completed")],
          [second.id, completedChildMessage(second.id, "second child completed")],
        ]),
        updatedParts,
      }),
    )
    const reconciled = taskPart(result[0]?.parts[0])

    expect(updatedParts).toHaveLength(0)
    expect(reconciled?.state.status).toBe("running")
  })

  test("uses title/time fallback when exactly one child candidate matches", async () => {
    const only = child("ses_only", "Plan next exercise page (@general subagent)", 1_050)
    const message = runningTaskMessage({ description: "Plan next exercise page", start: 1_000 })
    const updatedParts: MessageV2.Part[] = []

    const result = await Effect.runPromise(
      runReconcile({
        messages: [message],
        children: [only],
        childMessages: new Map([[only.id, completedChildMessage(only.id, "only child completed")]]),
        updatedParts,
      }),
    )
    const reconciled = taskPart(result[0]?.parts[0])

    expect(updatedParts).toHaveLength(1)
    expect(reconciled?.state.status).toBe("completed")
    if (reconciled?.state.status === "completed") {
      expect(reconciled.state.metadata.sessionId).toBe(only.id)
      expect(reconciled.state.output).toContain("only child completed")
    }
  })

  test("does not update an already reconciled completed task on subsequent Session.messages reads", async () => {
    const only = child("ses_once", "Plan next exercise page (@general subagent)", 1_050)
    const message = runningTaskMessage({ description: "Plan next exercise page", start: 1_000 })
    const updatedParts: MessageV2.Part[] = []
    const childMessages = new Map<SessionIDType, MessageV2.WithParts>([
      [only.id, completedChildMessage(only.id, "only child completed")],
    ])

    const first = await Effect.runPromise(
      runReconcile({ messages: [message], children: [only], childMessages, updatedParts }),
    )
    const firstPart = taskPart(first[0]?.parts[0])
    const firstEnd = firstPart?.state.status === "completed" ? firstPart.state.time.end : undefined

    const second = await Effect.runPromise(
      runReconcile({ messages: first, children: [only], childMessages, updatedParts }),
    )
    const secondPart = taskPart(second[0]?.parts[0])
    const secondEnd = secondPart?.state.status === "completed" ? secondPart.state.time.end : undefined

    expect(updatedParts).toHaveLength(1)
    expect(secondPart?.state.status).toBe("completed")
    expect(secondEnd).toBe(firstEnd)
  })
})

describe("Session", () => {
  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )
})

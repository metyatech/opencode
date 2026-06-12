import { describe, expect } from "bun:test"
import * as Log from "@opencode-ai/core/util/log"
import { Cause, Effect, Exit, Layer, Result } from "effect"
import { Session } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const providerID = ProviderID.make("test")
const clientModelID = ModelID.make("client-model")
const agentModelID = ModelID.make("agent-model")
const sessionModelID = ModelID.make("session-model")

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "client-model": model("client-model"),
        "agent-model": model("agent-model", { "agent-variant": {} }),
        "session-model": model("session-model"),
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

const it = testEffect(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))

function model(id: string, variants?: Record<string, Record<string, unknown>>) {
  return {
    id,
    name: id,
    attachment: false,
    reasoning: false,
    temperature: false,
    tool_call: true,
    release_date: "2025-01-01",
    limit: { context: 100000, output: 10000 },
    cost: { input: 0, output: 0 },
    options: {},
    ...(variants ? { variants } : {}),
  }
}

function config(agent: Record<string, unknown>) {
  return {
    ...cfg,
    agent: {
      managed: agent,
    },
  }
}

function promptOnce(agent = "managed") {
  return Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Managed agent enforcement",
      model: { providerID, id: sessionModelID },
    })
    return { prompt, session }
  }).pipe(
    Effect.flatMap(({ prompt, session }) =>
      prompt.prompt({
        sessionID: session.id,
        agent,
        model: { providerID, modelID: clientModelID },
        variant: "client-variant",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      }),
    ),
  )
}

function defectMessage(defect: unknown) {
  if (typeof defect !== "object" || defect === null || !("toObject" in defect)) return undefined
  const toObject = defect.toObject
  if (typeof toObject !== "function") return undefined
  const object = toObject.call(defect)
  if (typeof object !== "object" || object === null || !("data" in object)) return undefined
  const data = object.data
  if (typeof data !== "object" || data === null || !("message" in data)) return undefined
  return typeof data.message === "string" ? data.message : undefined
}

function userInfo(message: MessageV2.WithParts) {
  expect(message.info.role).toBe("user")
  if (message.info.role !== "user") throw new Error("expected user message")
  return message.info
}

describe("managed agent model enforcement", () => {
  it.instance(
    "managed agent ignores client model and uses agent model",
    () =>
      Effect.gen(function* () {
        const result = yield* promptOnce()
        const info = userInfo(result)

        expect(info.model.providerID).toBe(providerID)
        expect(info.model.modelID).toBe(agentModelID)
      }),
    {
      config: config({ model_selection: "managed", model: "test/agent-model" }),
    },
  )

  it.instance(
    "managed agent ignores client variant and uses agent variant",
    () =>
      Effect.gen(function* () {
        const result = yield* promptOnce()
        const info = userInfo(result)

        expect(info.model.modelID).toBe(agentModelID)
        expect(info.model.variant).toBe("agent-variant")
      }),
    {
      config: config({ model_selection: "managed", model: "test/agent-model", variant: "agent-variant" }),
    },
  )

  it.instance(
    "managed agent without configured model throws a clear error",
    () =>
      Effect.gen(function* () {
        const exit = yield* promptOnce().pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const die = Cause.findDie(exit.cause)
          expect(Result.isSuccess(die)).toBe(true)
          if (Result.isSuccess(die)) {
            expect(defectMessage(die.success.defect)).toBe(
              `Managed agent "managed" has no configured model. Configure the agent's 'model' field in opencode config.`,
            )
          }
        }
      }),
    {
      config: config({ model_selection: "managed" }),
    },
  )

  it.instance(
    "user-selected agent uses client model when provided",
    () =>
      Effect.gen(function* () {
        const result = yield* promptOnce()
        const info = userInfo(result)

        expect(info.model.providerID).toBe(providerID)
        expect(info.model.modelID).toBe(clientModelID)
      }),
    {
      config: config({ model_selection: "user", model: "test/agent-model" }),
    },
  )

  it.instance(
    "user-selected agent falls back to agent model when client model is missing",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Agent model fallback",
          model: { providerID, id: sessionModelID },
        })
        const result = yield* prompt.prompt({
          sessionID: session.id,
          agent: "managed",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        const info = userInfo(result)

        expect(info.model.providerID).toBe(providerID)
        expect(info.model.modelID).toBe(agentModelID)
      }),
    {
      config: config({ model_selection: "user", model: "test/agent-model" }),
    },
  )

  it.instance(
    "user-selected agent falls back to session current model when client and agent models are missing",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Session model fallback",
          model: { providerID, id: sessionModelID },
        })
        const result = yield* prompt.prompt({
          sessionID: session.id,
          agent: "managed",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        const info = userInfo(result)

        expect(info.model.providerID).toBe(providerID)
        expect(info.model.modelID).toBe(sessionModelID)
      }),
    {
      config: config({ model_selection: "user" }),
    },
  )
})

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer, Stream } from "effect"
import { LLM } from "../../src/session/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { testEffect } from "../lib/effect"
import type { Agent } from "../../src/agent/agent"

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

type ConfigModel = NonNullable<NonNullable<Config.Info["provider"]>[string]["models"]>[string]

const openAIConfig = (model: ModelsDev.Provider["models"][string], baseURL: string): Partial<Config.Info> => ({
  enabled_providers: ["openai"],
  provider: {
    openai: {
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      npm: "@ai-sdk/openai",
      api: "https://api.openai.com/v1",
      models: {
        [model.id]: JSON.parse(JSON.stringify(model)) as ConfigModel,
      },
      options: {
        apiKey: "test-openai-key",
        baseURL,
      },
    },
  },
})

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{
    path: string
    response: Response | ((req: Request, capture: Capture) => Response)
    resolve: (value: Capture) => void
  }>,
  captures: [] as Capture[],
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  state.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

function createOpenAIResponse() {
  const model = "gpt-5.2"
  const chunks = [
    {
      type: "response.created",
      response: {
        id: "resp-1",
        created_at: Math.floor(Date.now() / 1000),
        model,
        service_tier: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "item-1", status: "in_progress", role: "assistant", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: "item-1",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: "item-1",
      delta: "Hello",
      logprobs: null,
    },
    {
      type: "response.completed",
      response: {
        incomplete_details: null,
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: null,
        },
        service_tier: null,
      },
    },
  ]
  const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`)
  lines.push("data: [DONE]")
  const payload = lines.join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload))
        controller.close()
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  )
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const next = state.queue.shift()
      if (!next) {
        return new Response("unexpected request", { status: 500 })
      }
      const url = new URL(req.url)
      const body = (await req.json()) as Record<string, unknown>
      const capture: Capture = { url, headers: req.headers, body }
      state.captures.push(capture)
      next.resolve(capture)
      if (!url.pathname.endsWith(next.path)) {
        return new Response("not found", { status: 404 })
      }
      return typeof next.response === "function"
        ? next.response(req, capture)
        : next.response
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
  state.captures.length = 0
})

afterAll(() => {
  void state.server?.stop()
})

const MODELS_FIXTURE = JSON.parse(
  await Bun.file(path.join(import.meta.dir, "../tool/fixtures/models-api.json")).text(),
) as Record<string, ModelsDev.Provider>

function loadFixture(providerID: string, modelID: string) {
  const provider = MODELS_FIXTURE[providerID]
  if (!provider) throw new Error(`Missing provider in fixture: ${providerID}`)
  const model = provider.models[modelID]
  if (!model) throw new Error(`Missing model in fixture: ${modelID}`)
  return { provider, model }
}

const it = testEffect(
  Layer.mergeAll(
    LLM.defaultLayer,
    Provider.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Auth.defaultLayer,
    Config.defaultLayer,
    LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
    RuntimeFlags.defaultLayer,
  ),
)

const makeStreamInput = (model: ModelsDev.Model, sessionID = "ses_prepare_once") => {
  const resolved = {
    providerID: "openai",
    id: model.id,
    api: { id: model.id, npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
    name: model.name,
    limit: { context: 128_000, output: 8_000 },
    cost: { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: true,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    options: {},
    headers: {},
  } as never
  const agent = {
    name: "test",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  } satisfies Agent.Info
  return {
    user: {
      id: MessageID.make("msg_prepare_user"),
      sessionID: SessionID.make(sessionID),
      role: "user",
      time: { created: Date.now() },
      agent: agent.name,
      model: { providerID: "openai", modelID: resolved.id, variant: "high" },
    } satisfies MessageV2.User,
    sessionID,
    model: resolved,
    agent,
    system: ["You are a helpful assistant."],
    messages: [{ role: "user", content: "Hello" }] as never,
    tools: {},
  }
}

// `runTwoAttempts` was previously a shared helper. The tests now drive
// prepare + streamPrepared inline so the harness (it.instance) provides
// the right InstanceRef.

describe("session.llm.prepare + streamPrepared", () => {
  it.instance(
    "two streamPrepared calls from the same prepared invocation send byte-identical request bodies",
    () =>
      Effect.gen(function* () {
        const { model } = loadFixture("openai", "gpt-5.2")
        // Queue two 200 responses so the server has material to return.
        waitRequest("/responses", createOpenAIResponse())
        waitRequest("/responses", createOpenAIResponse())
        const svc = yield* LLM.Service
        const input = makeStreamInput(model)
        const prepared = yield* svc.prepare(input)
        yield* svc.streamPrepared(prepared, new AbortController().signal).pipe(Stream.runDrain)
        yield* svc.streamPrepared(prepared, new AbortController().signal).pipe(Stream.runDrain)
        expect(state.captures.length).toBe(2)
        const [a, b] = state.captures
        // The two bodies must match. prompt_cache_key is intentionally
        // asserted separately below, so allow it to be in either
        // position. Otherwise the bodies must be deep-equal.
        expect(a?.body).toEqual(b?.body)
      }),
    {
      config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`),
    },
  )

  it.instance(
    "prompt_cache_key is the sessionID on every attempt",
    () =>
      Effect.gen(function* () {
        const { model } = loadFixture("openai", "gpt-5.2")
        waitRequest("/responses", createOpenAIResponse())
        waitRequest("/responses", createOpenAIResponse())
        const svc = yield* LLM.Service
        const input = makeStreamInput(model)
        const prepared = yield* svc.prepare(input)
        yield* svc.streamPrepared(prepared, new AbortController().signal).pipe(Stream.runDrain)
        yield* svc.streamPrepared(prepared, new AbortController().signal).pipe(Stream.runDrain)
        expect(state.captures.length).toBe(2)
        const sessionID = input.sessionID
        for (const cap of state.captures) {
          expect(cap.body.prompt_cache_key).toBe(sessionID)
        }
      }),
    {
      config: () => openAIConfig(loadFixture("openai", "gpt-5.2").model, `${state.server!.url.origin}/v1`),
    },
  )
})

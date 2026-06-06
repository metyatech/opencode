import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { getSessionContextMetrics } from "./session-context-metrics"

const assistant = (
  id: string,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
  cost: number,
  providerID = "openai",
  modelID = "gpt-4.1",
) => {
  return {
    id,
    role: "assistant",
    providerID,
    modelID,
    cost,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: {
        read: tokens.read,
        write: tokens.write,
      },
    },
    time: { created: 1 },
  } as unknown as Message
}

const user = (id: string) => {
  return {
    id,
    role: "user",
    cost: 0,
    time: { created: 1 },
  } as unknown as Message
}

const stepFinish = (
  id: string,
  messageID: string,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
) => {
  return {
    id,
    sessionID: "ses_test",
    messageID,
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: {
        read: tokens.read,
        write: tokens.write,
      },
    },
  } as unknown as Part
}

describe("getSessionContextMetrics", () => {
  test("computes totals and usage from latest assistant with tokens", () => {
    const messages = [
      user("u1"),
      assistant("a1", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 0.5),
      assistant("a2", { input: 300, output: 100, reasoning: 50, read: 25, write: 25 }, 1.25),
    ]
    const providers = [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4.1": {
            name: "GPT-4.1",
            limit: { context: 1000, output: 100 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.totalCost).toBe(1.75)
    expect(metrics.context?.message.id).toBe("a2")
    expect(metrics.context?.total).toBe(500)
    expect(metrics.context?.limit).toBe(900)
    expect(metrics.context?.usage).toBe(56)
    expect(metrics.context?.providerLabel).toBe("OpenAI")
    expect(metrics.context?.modelLabel).toBe("GPT-4.1")
  })

  test("uses latest step-finish tokens including reasoning and cache writes while keeping cost cumulative", () => {
    const messages = [
      assistant("a1", { input: 20, output: 10, reasoning: 0, read: 0, write: 0 }, 0.25),
      assistant("a2", { input: 3_000_000, output: 500_000, reasoning: 10_000, read: 100_000, write: 0 }, 10),
    ]
    const parts = {
      a2: [
        stepFinish("step_old", "a2", { input: 800, output: 60, reasoning: 0, read: 80, write: 0 }),
        stepFinish("step_new", "a2", { input: 200, output: 10, reasoning: 5, read: 20, write: 7 }),
      ],
    }
    const providers = [
      {
        id: "openai",
        models: {
          "gpt-4.1": {
            limit: { context: 1000, output: 100 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers, parts)

    expect(metrics.totalCost).toBe(10.25)
    expect(metrics.context?.message.id).toBe("a2")
    expect(metrics.context?.input).toBe(200)
    expect(metrics.context?.output).toBe(10)
    expect(metrics.context?.reasoning).toBe(5)
    expect(metrics.context?.cacheRead).toBe(20)
    expect(metrics.context?.cacheWrite).toBe(7)
    expect(metrics.context?.total).toBe(242)
    expect(metrics.context?.usage).toBe(27)
  })

  test("uses input budget when the model has a dedicated prompt limit", () => {
    const messages = [assistant("a1", { input: 160, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1)]
    const providers = [
      {
        id: "openai",
        models: {
          "gpt-4.1": {
            limit: { context: 1000, input: 200, output: 100 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.context?.limit).toBe(100)
    expect(metrics.context?.usage).toBe(170)
  })

  test("preserves fallback labels and null usage when model metadata is missing", () => {
    const messages = [assistant("a1", { input: 40, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "p-1", "m-1")]
    const providers = [{ id: "p-1", models: {} }]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.context?.providerLabel).toBe("p-1")
    expect(metrics.context?.modelLabel).toBe("m-1")
    expect(metrics.context?.limit).toBeUndefined()
    expect(metrics.context?.usage).toBeNull()
  })

  test("recomputes when message array is mutated in place", () => {
    const messages = [assistant("a1", { input: 10, output: 10, reasoning: 10, read: 10, write: 10 }, 0.25)]
    const providers = [{ id: "openai", models: {} }]

    const one = getSessionContextMetrics(messages, providers)
    messages.push(assistant("a2", { input: 100, output: 20, reasoning: 0, read: 0, write: 0 }, 0.75))
    const two = getSessionContextMetrics(messages, providers)

    expect(one.context?.message.id).toBe("a1")
    expect(two.context?.message.id).toBe("a2")
    expect(two.totalCost).toBe(1)
  })

  test("returns empty metrics when inputs are undefined", () => {
    const metrics = getSessionContextMetrics(undefined, undefined)

    expect(metrics.totalCost).toBe(0)
    expect(metrics.context).toBeUndefined()
  })
})

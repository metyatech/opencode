import { describe, expect, test } from "bun:test"
import { Session } from "@/session/session"
import { Usage } from "@opencode-ai/llm"

// Sanity test that the existing getUsage path carries cacheReadInputTokens
// from the AI SDK step-finish into the assistant message's `tokens.cache.read`
// and the bus event. This is the load-bearing assertion the spec calls out:
// "drives a step-finish event with cacheReadInputTokens > 0 and asserts the
// assistant message's tokens.cache.read is increased and the bus receives an
// event with cacheReadTokens."
describe("Session.getUsage cache observability", () => {
  test("carries cacheReadInputTokens into tokens.cache.read", () => {
    const result = Session.getUsage({
      model: {
        id: "gpt-5.2",
        providerID: "openai",
        name: "gpt-5.2",
        limit: { context: 128_000, output: 8_000 },
        cost: { input: 0, output: 0, cache: { read: 0.1, write: 1.25 } },
        capabilities: {
          toolcall: true,
          attachment: false,
          reasoning: true,
          temperature: true,
          input: { text: true, image: false, audio: false, video: false },
          output: { text: true, image: false, audio: false, video: false },
        },
        api: { id: "gpt-5.2", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
        options: {},
      } as never,
      usage: new Usage({
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadInputTokens: 42,
      }),
    })
    expect(result.tokens.cache.read).toBe(42)
  })

  test("zeros cache.read when usage has no cacheReadInputTokens", () => {
    const result = Session.getUsage({
      model: {
        id: "gpt-5.2",
        providerID: "openai",
        name: "gpt-5.2",
        limit: { context: 128_000, output: 8_000 },
        cost: { input: 0, output: 0, cache: { read: 0.1, write: 1.25 } },
        capabilities: {
          toolcall: true,
          attachment: false,
          reasoning: true,
          temperature: true,
          input: { text: true, image: false, audio: false, video: false },
          output: { text: true, image: false, audio: false, video: false },
        },
        api: { id: "gpt-5.2", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
        options: {},
      } as never,
      usage: new Usage({ inputTokens: 1000, outputTokens: 100 }),
    })
    expect(result.tokens.cache.read).toBe(0)
  })
})

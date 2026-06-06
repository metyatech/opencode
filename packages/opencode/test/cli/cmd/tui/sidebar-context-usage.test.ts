import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"
import {
  hasAssistantContextTokens,
  latestAssistantRequestTokens,
} from "@/cli/cmd/tui/feature-plugins/sidebar/context-usage"

type StepFinishPart = Extract<Part, { type: "step-finish" }>

const assistant = (tokens: AssistantMessage["tokens"]) =>
  ({
    id: "msg_test",
    sessionID: "ses_test",
    role: "assistant",
    time: { created: 1 },
    parentID: "msg_parent",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: ".", root: "." },
    cost: 0,
    tokens,
  }) as AssistantMessage

const stepFinish = (id: string, tokens: AssistantMessage["tokens"]) =>
  ({
    id,
    sessionID: "ses_test",
    messageID: "msg_test",
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens,
  }) as StepFinishPart

describe("sidebar context usage", () => {
  test("uses latest step-finish tokens instead of cumulative assistant message tokens", () => {
    const message = assistant({
      input: 3_000_000,
      output: 500_000,
      reasoning: 0,
      cache: { read: 100_000, write: 0 },
    })
    const parts = [
      stepFinish("step_old", { input: 700, output: 100, reasoning: 0, cache: { read: 50, write: 0 } }),
      stepFinish("step_new", { input: 200, output: 10, reasoning: 0, cache: { read: 20, write: 0 } }),
    ]

    expect(latestAssistantRequestTokens({ message, parts })).toEqual(parts[1].tokens)
  })

  test("falls back to assistant message tokens when step-finish parts are unavailable", () => {
    const message = assistant({
      input: 200,
      output: 10,
      reasoning: 0,
      cache: { read: 20, write: 0 },
    })

    expect(latestAssistantRequestTokens({ message, parts: [] })).toEqual(message.tokens)
    expect(hasAssistantContextTokens({ message, parts: [] })).toBe(true)
  })

  test("treats reasoning-only and cache-write-only latest step-finish tokens as context usage", () => {
    const message = assistant({
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })

    expect(
      hasAssistantContextTokens({
        message,
        parts: [
          stepFinish("step_reasoning", {
            input: 0,
            output: 0,
            reasoning: 5,
            cache: { read: 0, write: 0 },
          }),
        ],
      }),
    ).toBe(true)
    expect(
      hasAssistantContextTokens({
        message,
        parts: [
          stepFinish("step_cache_write", {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 5 },
          }),
        ],
      }),
    ).toBe(true)
  })
})

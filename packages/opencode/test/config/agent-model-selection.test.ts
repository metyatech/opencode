import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Config } from "@/config/config"
import { ConfigAgent } from "../../src/config/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { testEffect } from "../lib/effect"

const decodeAgent = Schema.decodeUnknownSync(ConfigAgent.Info)
const it = testEffect(Layer.mergeAll(Config.defaultLayer, AgentSvc.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("ConfigAgent model_selection", () => {
  test("managed model selection parses", () => {
    expect(decodeAgent({ model_selection: "managed" }).model_selection).toBe("managed")
  })

  test("user model selection parses", () => {
    expect(decodeAgent({ model_selection: "user" }).model_selection).toBe("user")
  })

  test("omitted model selection stays undefined", () => {
    expect(decodeAgent({}).model_selection).toBeUndefined()
  })

  test("invalid model selection is rejected", () => {
    expect(() => decodeAgent({ model_selection: "auto" })).toThrow()
  })

  test("model selection is not promoted to options", () => {
    const agent = decodeAgent({ custom: true, model_selection: "managed" })
    const options = agent.options ?? {}
    expect(options).toEqual({ custom: true })
    expect(options.model_selection).toBeUndefined()
  })
})

it.instance(
  "Agent.get reflects configured model selection and normalizes unspecified agents to user",
  () =>
    Effect.gen(function* () {
      expect((yield* AgentSvc.use.get("build")).modelSelection).toBe("managed")
      expect((yield* AgentSvc.use.get("plan")).modelSelection).toBe("user")
      // Spec #6: an unspecified user agent is normalized to "user" at runtime
      // so the lock guard and footer label never see undefined.
      expect((yield* AgentSvc.use.get("general")).modelSelection).toBe("user")
    }),
  {
    git: true,
    config: {
      agent: {
        build: { model_selection: "managed" },
        plan: { model_selection: "user" },
        general: {},
      },
    },
  },
  30000,
)

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Config } from "@/config/config"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { testEffect } from "../lib/effect"

// Spec #6: every Agent.Info entry must have a non-undefined `modelSelection`
// ("user" or "managed") after config merging, so the TUI/App footer and the
// backend lock guard never see undefined at runtime.

const it = testEffect(Layer.mergeAll(Config.defaultLayer, AgentSvc.defaultLayer, CrossSpawnSpawner.defaultLayer))

it.instance(
  "every built-in agent has a normalized modelSelection of 'user' or 'managed' (no config)",
  () =>
    Effect.gen(function* () {
      const agents = yield* AgentSvc.use.list()
      expect(agents.length).toBeGreaterThan(0)
      for (const agent of agents) {
        expect(agent.modelSelection).not.toBeUndefined()
        expect(["user", "managed"] as const).toContain(agent.modelSelection as "user" | "managed")
      }
    }),
  { git: true },
  30000,
)

it.instance(
  "user-defined agents also end up with a normalized modelSelection of 'user' or 'managed'",
  () =>
    Effect.gen(function* () {
      const agents = yield* AgentSvc.use.list()
      // "managed" agent from config
      const managed = agents.find((a) => a.name === "managed")
      expect(managed).toBeDefined()
      expect(managed?.modelSelection).toBe("managed")

      // "user" agent from config
      const user = agents.find((a) => a.name === "user")
      expect(user).toBeDefined()
      expect(user?.modelSelection).toBe("user")

      // Unspecified built-in agent gets normalized to "user"
      const build = agents.find((a) => a.name === "build")
      expect(build).toBeDefined()
      expect(build?.modelSelection).toBe("user")
    }),
  {
    git: true,
    config: {
      agent: {
        managed: { model_selection: "managed", model: "test/managed-model" },
        user: { model_selection: "user" },
      },
    },
  },
  30000,
)

it.instance(
  "no agent in the merged list has an undefined modelSelection even with a complex config",
  () =>
    Effect.gen(function* () {
      const agents = yield* AgentSvc.use.list()
      const undefineds = agents.filter((a) => a.modelSelection === undefined)
      expect(undefineds).toEqual([])
    }),
  {
    git: true,
    config: {
      agent: {
        build: {},
        plan: { model_selection: "user" },
        explorer: { model_selection: "managed", model: "test/model" },
      },
    },
  },
  30000,
)

// Sanity: the schema is still optional at the config layer. We confirm the
// default path goes through the merge loop and ends with a real value.
it.instance(
  "unspecified config-level model_selection is normalized to 'user'",
  () =>
    Effect.gen(function* () {
      const agent = yield* AgentSvc.use.get("build")
      // build is a built-in with no model_selection in the test config.
      expect(agent.modelSelection).toBe("user")
    }),
  { git: true },
  30000,
)

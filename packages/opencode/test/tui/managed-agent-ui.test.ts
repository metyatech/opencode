import { describe, expect, test } from "bun:test"
import {
  isManagedAgent,
  managedAgentCurrentModel,
  MANAGED_AGENT_NOTICE,
  resolveAgentSet,
  type ManagedAgentShape,
} from "../../src/cli/cmd/tui/context/managed-agent"

const managed: ManagedAgentShape & { model?: { providerID: string; modelID: string } } = {
  modelSelection: "managed",
  model: { providerID: "test", modelID: "agent-model" },
}
const user: ManagedAgentShape & { model?: { providerID: string; modelID: string } } = {
  modelSelection: "user",
  model: { providerID: "test", modelID: "user-model" },
}

describe("isManagedAgent", () => {
  test("returns true for an agent with modelSelection 'managed'", () => {
    expect(isManagedAgent(managed)).toBe(true)
  })

  test("returns false for an agent with modelSelection 'user'", () => {
    expect(isManagedAgent(user)).toBe(false)
  })

  test("returns false for an agent with no modelSelection field", () => {
    expect(isManagedAgent({})).toBe(false)
  })

  test("returns false for an agent that omits modelSelection even if other fields are present", () => {
    // The discriminator is `modelSelection`, not the agent's name. An agent
    // named "build" with no modelSelection is treated as user-managed.
    const named = { name: "build" } as ManagedAgentShape
    expect(isManagedAgent(named)).toBe(false)
  })

  test("returns false for undefined", () => {
    expect(isManagedAgent(undefined)).toBe(false)
  })

  test("accepts the typed agent shape without a cast", () => {
    // The compile-time check here is the real assertion: this file
    // must type-check without `as Record<string, unknown>`.
    const typed: ManagedAgentShape = { modelSelection: "managed" }
    expect(isManagedAgent(typed)).toBe(true)
  })
})

describe("managedAgentCurrentModel", () => {
  test("returns the agent's configured model when managed", () => {
    expect(managedAgentCurrentModel(managed)).toEqual({
      providerID: "test",
      modelID: "agent-model",
    })
  })

  test("returns undefined for a non-managed agent", () => {
    expect(managedAgentCurrentModel(user)).toBeUndefined()
  })

  test("returns undefined for a managed agent without a configured model", () => {
    expect(managedAgentCurrentModel({ modelSelection: "managed" })).toBeUndefined()
  })

  test("returns undefined for an undefined agent", () => {
    expect(managedAgentCurrentModel(undefined)).toBeUndefined()
  })
})

describe("MANAGED_AGENT_NOTICE", () => {
  test("uses the generic copy that does not mention a specific agent name", () => {
    expect(MANAGED_AGENT_NOTICE).toBe(
      "This agent selects models automatically. Switch to a user-managed agent to choose a model manually.",
    )
  })
})

describe("resolveAgentSet", () => {
  test("clears the saved manual model when switching INTO a managed agent", () => {
    const current = {
      "Adaptive": { providerID: "test", modelID: "old" },
      build: { providerID: "test", modelID: "old-build" },
    }
    const target = { name: "Adaptive", modelSelection: "managed" as const }
    const next = resolveAgentSet(target, current)
    expect(next).toEqual({ build: { providerID: "test", modelID: "old-build" } })
  })

  test("preserves other agents' saved models when clearing a managed target", () => {
    const current = {
      Conductor: { providerID: "test", modelID: "conductor-pick" },
      Sentinel: { providerID: "test", modelID: "sentinel-pick" },
      build: { providerID: "test", modelID: "build-pick" },
    }
    const target = { name: "Conductor", modelSelection: "managed" as const }
    const next = resolveAgentSet(target, current)
    expect(next).toEqual({
      Sentinel: { providerID: "test", modelID: "sentinel-pick" },
      build: { providerID: "test", modelID: "build-pick" },
    })
  })

  test("does not modify the record when the target is a user-managed agent", () => {
    const current = {
      build: { providerID: "test", modelID: "old-build" },
    }
    const target = { name: "build", modelSelection: "user" as const }
    const next = resolveAgentSet(target, current)
    expect(next).toBe(current)
  })

  test("does not modify the record when the target is a managed agent with no saved entry", () => {
    const current = {
      build: { providerID: "test", modelID: "old-build" },
    }
    const target = { name: "Conductor", modelSelection: "managed" as const }
    const next = resolveAgentSet(target, current)
    expect(next).toBe(current)
  })
})

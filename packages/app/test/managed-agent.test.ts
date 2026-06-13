import { describe, expect, test } from "bun:test"
import {
  isManagedAgent,
  managedAgentCurrentModel,
  MANAGED_AGENT_NOTICE,
  resolveAgentSwitch,
  resolveSessionRestore,
  type AgentSwitchTarget,
  type ManagedAgentShape,
} from "@/lib/managed-agent"

const managed: AgentSwitchTarget = {
  name: "Conductor",
  modelSelection: "managed",
  model: { providerID: "test", modelID: "conductor-model" },
}
const user: AgentSwitchTarget = {
  name: "build",
  modelSelection: "user",
  model: { providerID: "test", modelID: "build-default" },
}

describe("managed agent", () => {
  test("detects an agent with modelSelection: managed", () => {
    expect(isManagedAgent(managed)).toBe(true)
  })

  test("ignores an agent with modelSelection: user", () => {
    expect(isManagedAgent(user)).toBe(false)
  })

  test("ignores an empty object", () => {
    expect(isManagedAgent({})).toBe(false)
  })

  test("ignores an agent that omits modelSelection even if other fields are present", () => {
    const named = { name: "build" } as ManagedAgentShape
    expect(isManagedAgent(named)).toBe(false)
  })

  test("ignores undefined", () => {
    expect(isManagedAgent(undefined)).toBe(false)
  })

  test("managedAgentCurrentModel returns the configured model when managed", () => {
    expect(managedAgentCurrentModel(managed)).toEqual({
      providerID: "test",
      modelID: "conductor-model",
    })
  })

  test("managedAgentCurrentModel returns undefined for a non-managed agent", () => {
    expect(managedAgentCurrentModel(user)).toBeUndefined()
  })

  test("managedAgentCurrentModel returns undefined for a managed agent without a model", () => {
    expect(managedAgentCurrentModel({ modelSelection: "managed" })).toBeUndefined()
  })

  test("exposes the generic managed agent notice string", () => {
    expect(MANAGED_AGENT_NOTICE).toBe(
      "This agent selects models automatically. Switch to a user-managed agent to choose a model manually.",
    )
  })
})

// Spec #5: switching INTO a managed agent clears the per-session model and
// variant pick. The agent's configured `model` is what `current()` will
// surface, so a prior user pick would be stale. Switching back to a
// user-managed agent keeps the user's prior selection.
describe("resolveAgentSwitch (switching agents)", () => {
  test("switching INTO a managed agent clears model and variant", () => {
    const next = resolveAgentSwitch(managed, {
      agent: "build",
      model: { providerID: "old", modelID: "old" },
      variant: "old",
    })
    expect(next).toEqual({
      agent: "Conductor",
      model: undefined,
      variant: null,
    })
  })

  test("switching INTO a user-managed agent with no agent-configured model keeps the prior user pick", () => {
    // The agent has no `model` of its own, so the prior per-session pick
    // survives the round-trip. (Per spec #5: "Normally agent向け保存
    // されていた履歴を不要に削除しないこと" -- the prior state is not
    // deleted; it is what `next.model` falls back to.)
    const userNoModel: AgentSwitchTarget = {
      name: "build",
      modelSelection: "user",
    }
    const prev = {
      agent: "build",
      model: { providerID: "test", modelID: "user-pick" },
      variant: "high" as string | null | undefined,
    }
    const next = resolveAgentSwitch(userNoModel, prev)
    expect(next).toEqual({
      agent: "build",
      model: { providerID: "test", modelID: "user-pick" },
      variant: "high",
    })
  })

  test("switching INTO a user-managed agent with no prior pick uses the agent's configured model", () => {
    const next = resolveAgentSwitch(user, undefined)
    expect(next).toEqual({
      agent: "build",
      model: { providerID: "test", modelID: "build-default" },
      variant: undefined,
    })
  })

  test("a different managed agent (not 'Adaptive') still gets the clear treatment", () => {
    const sentinel: AgentSwitchTarget = {
      name: "Sentinel",
      modelSelection: "managed",
      model: { providerID: "test", modelID: "sentinel-model" },
    }
    const next = resolveAgentSwitch(sentinel, {
      agent: "build",
      model: { providerID: "old", modelID: "old" },
      variant: "old",
    })
    expect(next.model).toBeUndefined()
    expect(next.variant).toBeNull()
  })
})

// Spec #5: session restore for a managed agent only restores the agent
// name. The stored message-time `model` is NOT promoted into the local
// selection -- the agent's configured `model` will be used instead.
describe("resolveSessionRestore", () => {
  test("managed agent restore drops the stored message model", () => {
    const next = resolveSessionRestore(managed, {
      agent: "Conductor",
      model: { providerID: "old", modelID: "stale-from-message" },
    })
    expect(next).toEqual({
      agent: "Conductor",
      model: undefined,
      variant: null,
    })
  })

  test("user-managed agent restore keeps the stored message model", () => {
    const next = resolveSessionRestore(user, {
      agent: "build",
      model: { providerID: "test", modelID: "kept-from-message" },
    })
    expect(next).toEqual({
      agent: "build",
      model: { providerID: "test", modelID: "kept-from-message" },
      variant: null,
    })
  })

  test("user-managed agent restore with a message variant promotes it", () => {
    const next = resolveSessionRestore(user, {
      agent: "build",
      model: { providerID: "test", modelID: "m", variant: "low" },
    })
    expect(next.variant).toBe("low")
  })

  test("restore with an unknown agent (not in the list) still falls through", () => {
    const next = resolveSessionRestore(undefined, {
      agent: "ghost",
      model: { providerID: "test", modelID: "ghost-model" },
    })
    expect(next.model).toEqual({ providerID: "test", modelID: "ghost-model" })
  })
})

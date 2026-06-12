import { describe, expect, test } from "bun:test"
import { isManagedAgent, MANAGED_AGENT_NOTICE } from "../../src/cli/cmd/tui/context/managed-agent"

describe("isManagedAgent", () => {
  test("returns true for an agent with modelSelection 'managed'", () => {
    expect(isManagedAgent({ modelSelection: "managed" })).toBe(true)
  })

  test("returns false for an agent with modelSelection 'user'", () => {
    expect(isManagedAgent({ modelSelection: "user" })).toBe(false)
  })

  test("returns false for an agent with no modelSelection field", () => {
    expect(isManagedAgent({})).toBe(false)
  })

  test("returns false for an empty agent shape", () => {
    expect(isManagedAgent({ name: "build" })).toBe(false)
  })

  test("returns false for undefined", () => {
    expect(isManagedAgent(undefined)).toBe(false)
  })
})

describe("MANAGED_AGENT_NOTICE", () => {
  test("matches the user-facing copy the TUI shows when the action is locked", () => {
    expect(MANAGED_AGENT_NOTICE).toBe(
      "Adaptive selects models automatically. Switch agents to choose a model manually.",
    )
  })
})

import { describe, expect, test } from "bun:test"
import { isManagedAgent, MANAGED_AGENT_NOTICE } from "@/lib/managed-agent"

describe("managed agent", () => {
  test("detects an agent with modelSelection: managed", () => {
    expect(isManagedAgent({ modelSelection: "managed" })).toBe(true)
  })

  test("ignores an agent with modelSelection: user", () => {
    expect(isManagedAgent({ modelSelection: "user" })).toBe(false)
  })

  test("ignores an empty object", () => {
    expect(isManagedAgent({})).toBe(false)
  })

  test("ignores an agent with only a name", () => {
    expect(isManagedAgent({ name: "build" })).toBe(false)
  })

  test("ignores undefined", () => {
    expect(isManagedAgent(undefined)).toBe(false)
  })

  test("exposes the managed agent notice string", () => {
    expect(MANAGED_AGENT_NOTICE).toBe(
      "Adaptive selects models automatically. Switch agents to choose a model manually.",
    )
  })
})

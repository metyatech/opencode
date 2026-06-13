import { describe, expect, test } from "bun:test"
import { formatAgentLabel } from "../../../src/cli/cmd/run/runtime.lifecycle"

// Spec #5: the footer agent label uses a generic "name · Auto" suffix for
// managed agents. The decision is based on the `isManaged` boolean, never
// on the agent's name. We exercise a synthetic agent name to prove the
// label is generic.
describe("formatAgentLabel", () => {
  test("appends ' · Auto' to a generic managed agent name", () => {
    expect(formatAgentLabel("Quantum", true)).toBe("Quantum · Auto")
  })

  test("does NOT add ' · Auto' to the same name when not managed", () => {
    expect(formatAgentLabel("Quantum", false)).toBe("Quantum")
  })

  test("falls back to 'Build' for an undefined agent name and respects the managed flag", () => {
    expect(formatAgentLabel(undefined, true)).toBe("Build · Auto")
    expect(formatAgentLabel(undefined, false)).toBe("Build")
  })

  test("titlecases the agent name regardless of the managed flag", () => {
    expect(formatAgentLabel("scout", true)).toBe("Scout · Auto")
    expect(formatAgentLabel("scout", false)).toBe("Scout")
  })

  test("treats a different synthetic managed agent name generically (not 'Adaptive' special case)", () => {
    // Confirms the label is not driven by a hardcoded "Adaptive" check.
    expect(formatAgentLabel("Conductor", true)).toBe("Conductor · Auto")
    expect(formatAgentLabel("Sentinel", true)).toBe("Sentinel · Auto")
  })
})

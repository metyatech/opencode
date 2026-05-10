import { describe, expect, test } from "bun:test"
import { renderVersionOutput } from "../../src/cli/cmd/version"

describe("cli.version", () => {
  const details = {
    version: "1.14.40-dev.182+sha.cdb3461",
    baseVersion: "1.14.40",
    channel: "dev",
    branch: "dev",
    commit: "cdb34610a5d6ab6b04f67219d1d1e2c247bbe750",
    shortCommit: "cdb3461",
    revision: 182,
    dirty: false,
    builtAt: "2026-05-10T02:00:00.000Z",
  }

  test("prints the short version string by default", () => {
    expect(renderVersionOutput(false, details, details.version)).toBe("1.14.40-dev.182+sha.cdb3461")
  })

  test("prints machine-readable version metadata when json is requested", () => {
    expect(JSON.parse(renderVersionOutput(true, details, details.version))).toEqual(details)
  })
})

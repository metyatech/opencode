import { describe, expect, test } from "bun:test"
import {
  createInstallationVersionInfo,
  formatPreviewVersion,
  normalizeVersionChannel,
  parseInstallationVersionInfo,
} from "@opencode-ai/core/installation/version"

describe("installation version metadata", () => {
  test("formats preview versions from source revision instead of build time", () => {
    expect(
      formatPreviewVersion({
        baseVersion: "1.14.40",
        channel: "dev",
        revision: 182,
        commit: "cdb34610a5d6ab6b04f67219d1d1e2c247bbe750",
      }),
    ).toBe("1.14.40-dev.182+sha.cdb3461")
  })

  test("sanitizes branch names for semver prerelease identifiers", () => {
    expect(normalizeVersionChannel("feature/version json")).toBe("feature-version-json")
  })

  test("preserves structured version metadata for json output", () => {
    const details = createInstallationVersionInfo({
      version: "1.14.40-dev.182+sha.cdb3461",
      baseVersion: "1.14.40",
      channel: "dev",
      branch: "dev",
      commit: "cdb34610a5d6ab6b04f67219d1d1e2c247bbe750",
      revision: 182,
      builtAt: "2026-05-10T02:00:00.000Z",
    })
    const parsed = parseInstallationVersionInfo(JSON.stringify(details), "local", "local")
    expect(parsed).toEqual({
      version: "1.14.40-dev.182+sha.cdb3461",
      baseVersion: "1.14.40",
      channel: "dev",
      branch: "dev",
      commit: "cdb34610a5d6ab6b04f67219d1d1e2c247bbe750",
      shortCommit: "cdb3461",
      revision: 182,
      dirty: false,
      builtAt: "2026-05-10T02:00:00.000Z",
    })
  })
})

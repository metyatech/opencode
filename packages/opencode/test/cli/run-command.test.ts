import { describe, expect, test } from "bun:test"
import { runAndAwaitSessionIdle, shouldDeferIdleExitAfterError } from "../../src/cli/cmd/run"

describe("cli.run", () => {
  test("waits for the session to become idle before resolving", async () => {
    let releaseIdle!: () => void
    const idle = new Promise<void>((resolve) => {
      releaseIdle = resolve
    })

    const run = runAndAwaitSessionIdle(async () => {}, idle)
    const early = await Promise.race([
      run.then(() => "resolved"),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 10)
      }),
    ])

    expect(early).toBe("pending")

    releaseIdle()
    await expect(run).resolves.toBeUndefined()
  })

  test("defers idle exit after an assistant error until fallback output can arrive", () => {
    expect(shouldDeferIdleExitAfterError({ error: "rate limited", emittedTextAfterError: false })).toBe(true)
    expect(shouldDeferIdleExitAfterError({ error: "rate limited", emittedTextAfterError: true })).toBe(false)
    expect(shouldDeferIdleExitAfterError({ error: undefined, emittedTextAfterError: false })).toBe(false)
  })
})

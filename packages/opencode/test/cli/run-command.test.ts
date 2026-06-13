import { describe, expect, test } from "bun:test"
import { pickLatestRootSession, runAndAwaitSessionIdle, runSessionLoop, shouldDeferIdleExit } from "../../src/cli/cmd/run"

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

  test("defers idle exit until fallback output can arrive when the run produced no output", () => {
    expect(shouldDeferIdleExit({ emittedOutput: false })).toBe(true)
    expect(shouldDeferIdleExit({ emittedOutput: true })).toBe(false)
  })
})

describe("cli.run runSessionLoop terminal-error behavior", () => {
  const sessionID = "ses_1"
  const baseOptions = {
    format: "default" as const,
    dangerouslySkipPermissions: false,
    thinking: false,
    emit: () => false,
  }

  // Minimal stand-in for the SDK client; runSessionLoop only calls
  // `client.permission.reply` when a `permission.asked` event arrives, which
  // the tests below never emit.
  const client = { permission: { reply: async () => ({}) } } as never

  function streamFrom(events: unknown[]) {
    return {
      stream: (async function* () {
        for (const event of events) yield event as never
      })(),
    }
  }

  test("returns undefined when a completed assistant text part is observed", async () => {
    const events = streamFrom([
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "p1",
            sessionID,
            messageID: "m1",
            type: "text",
            text: "hello world",
            time: { start: 1, end: 2 },
          },
        },
      },
      {
        type: "session.status",
        properties: { sessionID, status: { type: "idle" } },
      },
    ])

    const result = await runSessionLoop({ ...baseOptions, client, events, sessionID })
    expect(result).toBeUndefined()
  })

  test("returns the error when session.error arrives and no completion is observed", async () => {
    const events = streamFrom([
      {
        type: "session.error",
        properties: {
          sessionID,
          error: { name: "ProviderAuthError", data: { message: "token expired" } },
        },
      },
      {
        type: "session.status",
        properties: { sessionID, status: { type: "idle" } },
      },
    ])

    const result = await runSessionLoop({ ...baseOptions, client, events, sessionID })
    expect(result).toBe("token expired")
  })

  test("returns undefined when a transient session.error is recovered from by a completion", async () => {
    const events = streamFrom([
      {
        type: "session.error",
        properties: {
          sessionID,
          error: { name: "ProviderAuthError", data: { message: "token expired" } },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "p1",
            sessionID,
            messageID: "m1",
            type: "text",
            text: "recovered response",
            time: { start: 1, end: 2 },
          },
        },
      },
      {
        type: "session.status",
        properties: { sessionID, status: { type: "idle" } },
      },
    ])

    const result = await runSessionLoop({ ...baseOptions, client, events, sessionID })
    expect(result).toBeUndefined()
  })
})

describe("cli.run pickLatestRootSession", () => {
  test("returns the newest root session from an out-of-order list", () => {
    const items = [
      { id: "root-old", time: { updated: 100 } },
      { id: "child-mid", parentID: "root-old", time: { updated: 200 } },
      { id: "root-new", time: { updated: 300 } },
      { id: "root-mid", time: { updated: 250 } },
    ]
    expect(pickLatestRootSession(items)?.id).toBe("root-new")
  })

  test("returns undefined when no root session exists", () => {
    const items = [
      { id: "child-a", parentID: "missing", time: { updated: 200 } },
      { id: "child-b", parentID: "missing", time: { updated: 300 } },
    ]
    expect(pickLatestRootSession(items)).toBeUndefined()
  })

  test("skips a more-recent child and still returns the most-recent root", () => {
    const items = [
      { id: "root-a", time: { updated: 100 } },
      { id: "root-b", time: { updated: 50 } },
      { id: "child-late", parentID: "root-a", time: { updated: 999 } },
    ]
    const picked = pickLatestRootSession(items)
    expect(picked?.id).toBe("root-a")
  })

  test("returns undefined for an empty or undefined list", () => {
    expect(pickLatestRootSession(undefined)).toBeUndefined()
    expect(pickLatestRootSession([])).toBeUndefined()
  })

  test("treats missing or non-finite time.updated as 0 (oldest)", () => {
    const items = [
      { id: "no-time" },
      { id: "string-time", time: { updated: "100" } },
      { id: "nan-time", time: { updated: "not-a-number" } },
      { id: "null-time", time: { updated: null } },
    ]
    // The string "100" parses to 100; the others fall back to 0. So the
    // newest root is "string-time". This locks in the fallback contract.
    expect(pickLatestRootSession(items)?.id).toBe("string-time")
  })

  test("does not mutate the input array", () => {
    const items = [
      { id: "a", time: { updated: 100 } },
      { id: "b", time: { updated: 300 } },
      { id: "c", time: { updated: 200 } },
    ]
    const snapshot = items.map((item) => item.id)
    pickLatestRootSession(items)
    expect(items.map((item) => item.id)).toEqual(snapshot)
  })
})

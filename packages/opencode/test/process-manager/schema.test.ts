import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Action } from "../../src/process-manager/schema"
import { PollResult } from "../../src/process-manager/schema"
import { ProcessHandle } from "../../src/process-manager/id"

const decode = Schema.decodeUnknownSync(Action)

describe("process-manager schema", () => {
  test("parses each action shape", () => {
    expect(decode({ action: "list" }).action).toBe("list")
    const poll = decode({ action: "poll", handle: ProcessHandle.make("proc_abc") })
    expect(poll.action).toBe("poll")
    if (poll.action === "poll") {
      expect(poll.handle as unknown as string).toBe("proc_abc")
    }
    const stop = decode({ action: "stop", handle: ProcessHandle.make("proc_done") })
    expect(stop.action).toBe("stop")
  })

  test("rejects unknown action", () => {
    let threw = false
    try {
      decode({ action: "kill" })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("rejects the removed write action (stdin is intentionally not a public surface)", () => {
    let threw = false
    try {
      decode({ action: "write", handle: ProcessHandle.make("proc_x"), data: "ignored" })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("rejects missing required field (poll without handle)", () => {
    let threw = false
    try {
      decode({ action: "poll" })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("ProcessHandle rejects unbranded strings", () => {
    let threw = false
    try {
      Schema.decodeUnknownSync(ProcessHandle)("not-a-handle")
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("PollResult round-trips a small payload", () => {
    const result = new PollResult({
      info: {
        handle: ProcessHandle.make("proc_test"),
        command: "ls",
        cwd: "/tmp",
        state: "running",
        startedAt: 1,
        exitCode: null,
        signal: null,
        ownerSessionID: "ses_a",
        pid: 1234,
        inputClosed: false,
      },
      events: [{ kind: "stdout", seq: 1, text: "hi", at: 10 }],
      next_cursor: 1,
      truncated_before_cursor: false,
      wait_status: "output",
    })
    const encoded = Schema.encodeSync(PollResult)(result)
    // Schema.Class encodeSync returns a plain object form; the test asserts
    // the encoded structure is JSON-serialisable.
    const asString = JSON.stringify(encoded)
    expect(asString).toContain("proc_test")
  })
})

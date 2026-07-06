import { describe, expect, test } from "bun:test"
import { __test__ } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"

const { detectRepeatedToolObservationLoop, isLiveEmptyProcessPollWaitObservation } = __test__

const PARENT = "msg_parent" as unknown as MessageID

// Build a completed tool part. Only the fields the no-progress guard reads are
// populated; the object is cast to the part type for the detector under test.
function toolPart(tool: string, input: unknown, output: string): MessageV2.ToolPart {
  return {
    type: "tool",
    tool,
    state: { status: "completed", input, output },
  } as unknown as MessageV2.ToolPart
}

// One assistant step: step-start, a single tool, then step-finish carrying the
// snapshot the fingerprint is keyed on.
function assistantStep(id: string, part: MessageV2.ToolPart, snapshot = "snap"): MessageV2.WithParts {
  return {
    info: { role: "assistant", id, parentID: PARENT },
    parts: [{ type: "step-start", snapshot }, part, { type: "step-finish", snapshot }],
  } as unknown as MessageV2.WithParts
}

// Three identical assistant steps under the same parent — the shape the guard
// inspects for a no-progress loop.
function threeIdentical(part: () => MessageV2.ToolPart): MessageV2.WithParts[] {
  return ["msg_a", "msg_b", "msg_c"].map((id) => assistantStep(id, part()))
}

const livePollInput = { action: "poll", handle: "proc_x", cursor: 0, wait_ms: 300000 }
const liveTimeoutOutput = JSON.stringify({
  info: { state: "running" },
  events: [],
  next_cursor: 0,
  truncated_before_cursor: false,
  wait_status: "timeout",
})

describe("isLiveEmptyProcessPollWaitObservation", () => {
  test("true for a live empty long-poll timeout on a running process", () => {
    expect(isLiveEmptyProcessPollWaitObservation(toolPart("process", livePollInput, liveTimeoutOutput))).toBe(
      true,
    )
  })

  test("false when wait_ms is omitted", () => {
    const input = { action: "poll", handle: "proc_x", cursor: 0 } as Record<string, unknown>
    expect(isLiveEmptyProcessPollWaitObservation(toolPart("process", input, liveTimeoutOutput))).toBe(false)
  })

  test("false when poll targets a terminal process", () => {
    const terminalOutput = JSON.stringify({
      info: { state: "exited", exitCode: 0 },
      events: [],
      next_cursor: 0,
      truncated_before_cursor: false,
      wait_status: "terminal",
    })
    expect(isLiveEmptyProcessPollWaitObservation(toolPart("process", livePollInput, terminalOutput))).toBe(false)
  })

  test("false when events array is non-empty", () => {
    const eventsOutput = JSON.stringify({
      info: { state: "running" },
      events: [{ type: "stdout", data: "x" }],
      next_cursor: 1,
      truncated_before_cursor: false,
      wait_status: "output",
    })
    expect(isLiveEmptyProcessPollWaitObservation(toolPart("process", livePollInput, eventsOutput))).toBe(false)
  })

  test("false when output is empty (immediate poll return)", () => {
    expect(isLiveEmptyProcessPollWaitObservation(toolPart("process", livePollInput, ""))).toBe(false)
  })

  test("false when output JSON contains an error", () => {
    const errorOutput = JSON.stringify({
      error: { message: "process not found or not owned by this session", kind: "Internal" },
      info: { state: "running" },
      events: [],
      next_cursor: 0,
      truncated_before_cursor: false,
      wait_status: "timeout",
    })
    expect(isLiveEmptyProcessPollWaitObservation(toolPart("process", livePollInput, errorOutput))).toBe(false)
  })

  test("false for a non-process tool", () => {
    expect(isLiveEmptyProcessPollWaitObservation(toolPart("read", livePollInput, liveTimeoutOutput))).toBe(false)
  })
})

describe("detectRepeatedToolObservationLoop with process poll waits", () => {
  test("live empty long-poll timeout is excluded and repeated 3 times does not trigger guard", () => {
    const msgs = threeIdentical(() => toolPart("process", livePollInput, liveTimeoutOutput))
    expect(detectRepeatedToolObservationLoop(msgs, PARENT)).toBeUndefined()
  })

  test("wait_ms omitted triggers guard (immediate poll is not a long-poll)", () => {
    const makeImmediate = () =>
      toolPart(
        "process",
        { action: "poll", handle: "proc_x", cursor: 0 } as Record<string, unknown>,
        "",
      )
    const msgs = threeIdentical(makeImmediate)
    expect(detectRepeatedToolObservationLoop(msgs, PARENT)).toBeDefined()
  })

  test("terminal process poll triggers guard", () => {
    const makeTerminal = () => {
      const terminalOutput = JSON.stringify({
        info: { state: "exited", exitCode: 0 },
        events: [],
        next_cursor: 0,
        truncated_before_cursor: false,
        wait_status: "terminal",
      })
      return toolPart("process", livePollInput, terminalOutput)
    }
    const msgs = threeIdentical(makeTerminal)
    expect(detectRepeatedToolObservationLoop(msgs, PARENT)).toBeDefined()
  })

  test("poll returning new events triggers guard", () => {
    const makeEvents = () => {
      const eventsOutput = JSON.stringify({
        info: { state: "running" },
        events: [{ type: "stdout", data: "x" }],
        next_cursor: 1,
        truncated_before_cursor: false,
        wait_status: "output",
      })
      return toolPart("process", livePollInput, eventsOutput)
    }
    const msgs = threeIdentical(makeEvents)
    expect(detectRepeatedToolObservationLoop(msgs, PARENT)).toBeDefined()
  })

  test("poll with output triggers guard", () => {
    const makeOutput = () => toolPart("process", livePollInput, "anything")
    const msgs = threeIdentical(makeOutput)
    expect(detectRepeatedToolObservationLoop(msgs, PARENT)).toBeDefined()
  })

  test("poll whose output JSON carries an error triggers guard", () => {
    const makeError = () => {
      const errorOutput = JSON.stringify({
        error: { message: "process not found or not owned by this session", kind: "Internal" },
        info: { state: "running" },
        events: [],
        next_cursor: 0,
        truncated_before_cursor: false,
        wait_status: "timeout",
      })
      return toolPart("process", livePollInput, errorOutput)
    }
    const msgs = threeIdentical(makeError)
    expect(detectRepeatedToolObservationLoop(msgs, PARENT)).toBeDefined()
  })

  test("non-process repeated observation still triggers guard", () => {
    const msgs = threeIdentical(() => toolPart("read", { filePath: "/a" }, "same output"))
    expect(detectRepeatedToolObservationLoop(msgs, PARENT)).toBeDefined()
  })
})

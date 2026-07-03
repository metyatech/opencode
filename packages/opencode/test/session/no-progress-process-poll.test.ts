import { describe, expect, test } from "bun:test"
import { __test__ } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"

const { detectRepeatedToolObservationLoop, isProcessPollObservation } = __test__

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

describe("isProcessPollObservation", () => {
  test("true for a process poll with any output", () => {
    expect(isProcessPollObservation(toolPart("process", livePollInput, liveTimeoutOutput))).toBe(true)
  })

  test("true for a process poll with empty output", () => {
    expect(isProcessPollObservation(toolPart("process", livePollInput, ""))).toBe(true)
  })

  test("false for a non-process tool", () => {
    expect(isProcessPollObservation(toolPart("read", livePollInput, liveTimeoutOutput))).toBe(false)
  })

  test("false for a process tool without poll action", () => {
    expect(isProcessPollObservation(toolPart("process", { action: "spawn", handle: "proc_x" }, liveTimeoutOutput))).toBe(false)
  })
})

describe("detectRepeatedToolObservationLoop with process poll waits", () => {
  test("process poll with any output shape is ignored", () => {
    const msgs = threeIdentical(() => toolPart("process", livePollInput, liveTimeoutOutput))
    expect(detectRepeatedToolObservationLoop(msgs, PARENT)).toBeUndefined()
  })

  test("process poll with empty output is ignored", () => {
    const msgs = threeIdentical(() => toolPart("process", livePollInput, ""))
    expect(detectRepeatedToolObservationLoop(msgs, PARENT)).toBeUndefined()
  })

  test("non-process repeated tool observation is still guarded", () => {
    const msgs = threeIdentical(() => toolPart("read", { filePath: "/a" }, "same output"))
    expect(detectRepeatedToolObservationLoop(msgs, PARENT)).toBeDefined()
  })
})

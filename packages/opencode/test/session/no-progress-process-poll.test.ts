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
  test("true for a live empty process poll with wait_ms and wait_status timeout", () => {
    expect(isLiveEmptyProcessPollWaitObservation(toolPart("process", livePollInput, liveTimeoutOutput))).toBe(true)
  })

  test("true when wait_status is absent (back-compat)", () => {
    const output = JSON.stringify({ info: { state: "running" }, events: [], next_cursor: 0, truncated_before_cursor: false })
    expect(isLiveEmptyProcessPollWaitObservation(toolPart("process", livePollInput, output))).toBe(true)
  })

  test("false without wait_ms", () => {
    expect(
      isLiveEmptyProcessPollWaitObservation(toolPart("process", { action: "poll", handle: "proc_x", cursor: 0 }, liveTimeoutOutput)),
    ).toBe(false)
  })

  test("false for wait_ms 0", () => {
    expect(
      isLiveEmptyProcessPollWaitObservation(
        toolPart("process", { action: "poll", handle: "proc_x", cursor: 0, wait_ms: 0 }, liveTimeoutOutput),
      ),
    ).toBe(false)
  })

  test("false for wait_status immediate", () => {
    const output = JSON.stringify({ info: { state: "running" }, events: [], next_cursor: 0, truncated_before_cursor: false, wait_status: "immediate" })
    expect(isLiveEmptyProcessPollWaitObservation(toolPart("process", livePollInput, output))).toBe(false)
  })

  test("false for a terminal poll", () => {
    const output = JSON.stringify({ info: { state: "exited" }, events: [], next_cursor: 0, truncated_before_cursor: false, wait_status: "terminal" })
    expect(isLiveEmptyProcessPollWaitObservation(toolPart("process", livePollInput, output))).toBe(false)
  })

  test("false when events are present", () => {
    const output = JSON.stringify({
      info: { state: "running" },
      events: [{ kind: "stdout", seq: 1, text: "x", at: 1 }],
      next_cursor: 1,
      truncated_before_cursor: false,
      wait_status: "output",
    })
    expect(isLiveEmptyProcessPollWaitObservation(toolPart("process", livePollInput, output))).toBe(false)
  })

  test("false for an error result", () => {
    const output = JSON.stringify({ error: { message: "process not found", kind: "NotFound" } })
    expect(isLiveEmptyProcessPollWaitObservation(toolPart("process", livePollInput, output))).toBe(false)
  })

  test("false for a non-process tool", () => {
    expect(isLiveEmptyProcessPollWaitObservation(toolPart("read", livePollInput, liveTimeoutOutput))).toBe(false)
  })
})

describe("detectRepeatedToolObservationLoop with process poll waits", () => {
  test("live empty process poll with wait_ms is ignored", () => {
    const msgs = threeIdentical(() => toolPart("process", livePollInput, liveTimeoutOutput))
    expect(detectRepeatedToolObservationLoop(msgs, PARENT)).toBeUndefined()
  })

  test("live empty process poll without wait_ms is still guarded", () => {
    const msgs = threeIdentical(() => toolPart("process", { action: "poll", handle: "proc_x", cursor: 0 }, liveTimeoutOutput))
    expect(detectRepeatedToolObservationLoop(msgs, PARENT)).toBeDefined()
  })

  test("live empty process poll with wait_ms 0 is still guarded", () => {
    const msgs = threeIdentical(() =>
      toolPart("process", { action: "poll", handle: "proc_x", cursor: 0, wait_ms: 0 }, liveTimeoutOutput),
    )
    expect(detectRepeatedToolObservationLoop(msgs, PARENT)).toBeDefined()
  })

  test("process poll with wait_status immediate is still guarded", () => {
    const output = JSON.stringify({ info: { state: "running" }, events: [], next_cursor: 0, truncated_before_cursor: false, wait_status: "immediate" })
    const msgs = threeIdentical(() => toolPart("process", livePollInput, output))
    expect(detectRepeatedToolObservationLoop(msgs, PARENT)).toBeDefined()
  })

  test("terminal empty process poll is still guarded", () => {
    const output = JSON.stringify({ info: { state: "exited" }, events: [], next_cursor: 0, truncated_before_cursor: false, wait_status: "terminal" })
    const msgs = threeIdentical(() => toolPart("process", livePollInput, output))
    expect(detectRepeatedToolObservationLoop(msgs, PARENT)).toBeDefined()
  })

  test("process poll with events is still guarded", () => {
    const output = JSON.stringify({
      info: { state: "running" },
      events: [{ kind: "stdout", seq: 1, text: "x", at: 1 }],
      next_cursor: 1,
      truncated_before_cursor: false,
      wait_status: "output",
    })
    const msgs = threeIdentical(() => toolPart("process", livePollInput, output))
    expect(detectRepeatedToolObservationLoop(msgs, PARENT)).toBeDefined()
  })

  test("process error output is still guarded", () => {
    const output = JSON.stringify({ error: { message: "process not found", kind: "NotFound" } })
    const msgs = threeIdentical(() => toolPart("process", livePollInput, output))
    expect(detectRepeatedToolObservationLoop(msgs, PARENT)).toBeDefined()
  })

  test("non-process repeated tool observation is still guarded", () => {
    const msgs = threeIdentical(() => toolPart("read", { filePath: "/a" }, "same output"))
    expect(detectRepeatedToolObservationLoop(msgs, PARENT)).toBeDefined()
  })
})

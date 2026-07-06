import { describe, expect, test } from "bun:test"
import { __test__ } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"

const { internalContinuationInstructionText } = __test__

const USER_ID = "msg_user" as unknown as MessageID
const INTERNAL_ID = "msg_internal" as unknown as MessageID
const ASSISTANT_ID = "msg_assistant" as unknown as MessageID

function userMessage(id: MessageID, parts: MessageV2.Part[]): MessageV2.WithParts {
  return {
    info: { role: "user", id, sessionID: "session" as unknown as MessageID, agent: "test", model: { providerID: "test" as any, modelID: "test" as any }, time: { created: 1 } },
    parts,
  } as unknown as MessageV2.WithParts
}

function assistantMessage(id: MessageID, parentID: MessageID): MessageV2.WithParts {
  return {
    info: { role: "assistant", id, parentID, sessionID: "session" as unknown as MessageID, agent: "test", model: { providerID: "test" as any, modelID: "test" as any }, time: { created: 1 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, mode: "build" },
    parts: [],
  } as unknown as MessageV2.WithParts
}

function textPart(text: string, synthetic?: boolean, metadata?: Record<string, unknown>): MessageV2.TextPart {
  return {
    type: "text",
    id: "part" as unknown as MessageID,
    messageID: INTERNAL_ID,
    sessionID: "session" as unknown as MessageID,
    text,
    synthetic,
    metadata,
  } as unknown as MessageV2.TextPart
}

describe("internalContinuationInstructionText", () => {
  test("no pending continuation returns undefined", () => {
    const msgs: MessageV2.WithParts[] = []
    const result = internalContinuationInstructionText(msgs, undefined, false)
    expect(result).toBeUndefined()
  })

  test("pending continuation with no matching message returns undefined", () => {
    const msgs: MessageV2.WithParts[] = [
      userMessage(USER_ID, [textPart("hello")]),
      assistantMessage(ASSISTANT_ID, USER_ID),
    ]
    const internalContinuation = msgs[0].info as MessageV2.User
    const result = internalContinuationInstructionText(msgs, internalContinuation, true)
    expect(result).toBeUndefined()
  })

  test("pending compaction continuation becomes a system instruction", () => {
    const compactionPart = textPart("Continue the refactor task from before the context limit.", true, { compaction_continue: true })
    const internalMsg = userMessage(INTERNAL_ID, [compactionPart])
    const msgs: MessageV2.WithParts[] = [
      internalMsg,
      assistantMessage(ASSISTANT_ID, USER_ID),
    ]
    const internalContinuation = msgs[0].info as MessageV2.User
    const result = internalContinuationInstructionText(msgs, internalContinuation, true)
    expect(result).toContain("Internal continuation instruction")
    expect(result).toContain("Continue the refactor task from before the context limit.")
  })

  test("OMO marker is stripped from text", () => {
    const compactionPart = textPart(
      "Some text\n\n<!-- OMO_INTERNAL_INITIATOR -->\n\nMore continuation text",
      true,
      { compaction_continue: true },
    )
    const internalMsg = userMessage(INTERNAL_ID, [compactionPart])
    const msgs: MessageV2.WithParts[] = [internalMsg]
    const internalContinuation = msgs[0].info as MessageV2.User
    const result = internalContinuationInstructionText(msgs, internalContinuation, true)
    expect(result).not.toContain("OMO_INTERNAL_INITIATOR")
    expect(result).toContain("Some text")
    expect(result).toContain("More continuation text")
  })

  test("synthetic non-compaction text is ignored", () => {
    // A text part that is synthetic but does NOT have compaction_continue metadata
    const syntheticPart = textPart("This is just a synthetic note", true)
    const internalMsg = userMessage(INTERNAL_ID, [syntheticPart])
    const msgs: MessageV2.WithParts[] = [internalMsg]
    const internalContinuation = msgs[0].info as MessageV2.User
    const result = internalContinuationInstructionText(msgs, internalContinuation, true)
    expect(result).toBeUndefined()
  })

  test("empty text after stripping returns undefined", () => {
    const compactionPart = textPart("\n\n<!-- OMO_INTERNAL_INITIATOR -->\n\n", true, { compaction_continue: true })
    const internalMsg = userMessage(INTERNAL_ID, [compactionPart])
    const msgs: MessageV2.WithParts[] = [internalMsg]
    const internalContinuation = msgs[0].info as MessageV2.User
    const result = internalContinuationInstructionText(msgs, internalContinuation, true)
    expect(result).toBeUndefined()
  })

  test("multiple text parts are joined with double newlines", () => {
    const part1 = textPart("First part of continuation", true, { compaction_continue: true })
    const part2 = textPart("Second part of continuation", true, { compaction_continue: true })
    const internalMsg = userMessage(INTERNAL_ID, [part1, part2])
    const msgs: MessageV2.WithParts[] = [internalMsg]
    const internalContinuation = msgs[0].info as MessageV2.User
    const result = internalContinuationInstructionText(msgs, internalContinuation, true)
    expect(result).toContain("First part of continuation")
    expect(result).toContain("Second part of continuation")
    expect(result).toContain("\n\n")
  })
})

import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"
import { tokenTotal } from "@/session/overflow"

type StepFinishPart = Extract<Part, { type: "step-finish" }>

function isStepFinishPart(part: Part): part is StepFinishPart {
  return part.type === "step-finish"
}

export function latestAssistantRequestTokens(input: { message: AssistantMessage; parts: readonly Part[] }) {
  const step = input.parts.filter(isStepFinishPart).at(-1)
  return step?.tokens ?? input.message.tokens
}

export function hasAssistantContextTokens(input: { message: AssistantMessage; parts: readonly Part[] }) {
  return tokenTotal(latestAssistantRequestTokens(input)) > 0
}

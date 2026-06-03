import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk/v2/client"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
    input?: number
    output?: number
  }
}

type Context = {
  message: AssistantMessage
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  usage: number | null
}

type Metrics = {
  totalCost: number
  context: Context | undefined
}

type PartMap = Record<string, readonly Part[] | undefined>
type StepFinishPart = Extract<Part, { type: "step-finish" }>
type TokenUsage = AssistantMessage["tokens"]

const tokenTotal = (tokens: TokenUsage) => {
  return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
}

const isStepFinishPart = (part: Part): part is StepFinishPart => {
  return part.type === "step-finish"
}

const currentContextTokens = (msg: AssistantMessage, parts: PartMap = {}) => {
  const step = parts[msg.id]?.filter(isStepFinishPart).at(-1)
  return step?.tokens ?? msg.tokens
}

const OUTPUT_TOKEN_MAX = 32_000
const COMPACTION_BUFFER = 20_000

const effectiveLimit = (model?: Model) => {
  const context = model?.limit.context
  if (!context) return
  const output = Math.min(model?.limit.output ?? 0, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX
  const reserved = Math.min(COMPACTION_BUFFER, output)
  return model?.limit.input ? Math.max(0, model.limit.input - reserved) : Math.max(0, context - output)
}

const lastAssistantWithTokens = (messages: Message[], parts: PartMap) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    if (tokenTotal(currentContextTokens(msg, parts)) <= 0) continue
    return msg
  }
}

const build = (messages: Message[] = [], providers: Provider[] = [], parts: PartMap = {}): Metrics => {
  const totalCost = messages.reduce((sum, msg) => sum + (msg.role === "assistant" ? msg.cost : 0), 0)
  const message = lastAssistantWithTokens(messages, parts)
  if (!message) return { totalCost, context: undefined }

  const provider = providers.find((item) => item.id === message.providerID)
  const model = provider?.models[message.modelID]
  const limit = effectiveLimit(model)
  const tokens = currentContextTokens(message, parts)
  const total = tokenTotal(tokens)

  return {
    totalCost,
    context: {
      message,
      provider,
      model,
      providerLabel: provider?.name ?? message.providerID,
      modelLabel: model?.name ?? message.modelID,
      limit,
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cacheRead: tokens.cache.read,
      cacheWrite: tokens.cache.write,
      total,
      usage: limit ? Math.round((total / limit) * 100) : null,
    },
  }
}

export function getSessionContextMetrics(messages: Message[] = [], providers: Provider[] = [], parts: PartMap = {}) {
  return build(messages, providers, parts)
}

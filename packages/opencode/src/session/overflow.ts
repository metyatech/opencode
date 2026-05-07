import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

export function tokenCount(tokens: MessageV2.Assistant["tokens"]) {
  return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
}

export function reserved(input: { cfg: Config.Info; model: Provider.Model }) {
  return input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
}

export function usable(input: { cfg: Config.Info; model: Provider.Model }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reservedTokens = reserved(input)
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reservedTokens)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model))
}

export function usage(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  const total = tokenCount(input.tokens)
  const limit = usable(input)
  return {
    total,
    limit,
    percent: limit ? Math.round((total / limit) * 100) : undefined,
  }
}

export function isOverflow(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  return tokenCount(input.tokens) >= usable(input)
}

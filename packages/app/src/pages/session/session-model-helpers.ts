import type { UserMessage } from "@opencode-ai/sdk/v2"
import { isManagedAgent } from "@/lib/managed-agent"

type Local = {
  agent: {
    list: () => ReadonlyArray<{ name: string } & Record<string, unknown>>
  }
  session: {
    reset(): void
    restore(msg: UserMessage): void
  }
}

export const resetSessionModel = (local: Local) => {
  local.session.reset()
}

export const syncSessionModel = (local: Local, msg: UserMessage) => {
  const agents = local.agent.list()
  const restored = agents.find((item) => item.name === msg.agent)
  if (isManagedAgent(restored)) return
  local.session.restore(msg)
}

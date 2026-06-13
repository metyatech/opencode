/**
 * Notice shown to the user when they try to switch model/provider/variant
 * while a managed agent is the current agent.
 *
 * Generic wording -- intentionally does not mention any specific agent name
 * so the same copy is correct for every managed (Adaptive-style) agent.
 */
export const MANAGED_AGENT_NOTICE =
  "This agent selects models automatically. Switch to a user-managed agent to choose a model manually."

// Note: the TUI has no per-session model restore path that promotes a
// message-time `model` into the local selection (the TUI's local state is
// set explicitly by the user). The App's `resolveSessionRestore` covers
// the equivalent case in the App -- see `packages/app/src/lib/managed-agent.ts`.

/**
 * The minimum shape needed to decide whether an agent is "managed".
 *
 * The TUI and App both consume agent objects that come from two sources:
 * the OpenCode server's internal `Agent.Info`, and the SDK's wire-shape
 * `Agent` (where `modelSelection` is optional on the type but always
 * normalized to a value at runtime per Spec #6). Accepting this minimal
 * structural shape lets every call site pass the typed object directly
 * without a `Record<string, unknown>` cast.
 */
export type ManagedAgentShape = {
  modelSelection?: "user" | "managed"
}

/**
 * Returns true when the given agent selects its model automatically.
 *
 * A managed agent picks its model itself; the user must not be able to
 * switch its model, provider, or variant from the TUI. The decision is
 * based on the typed `modelSelection` discriminator, never on a name
 * check.
 */
export function isManagedAgent(agent: ManagedAgentShape | undefined): boolean {
  if (!agent) return false
  return agent.modelSelection === "managed"
}

/**
 * Returns the model configured on a managed agent, or `undefined` if the
 * agent has no `model` set.
 *
 * This is the only model source a managed agent's `currentModel()` should
 * consult: spec #5 forbids falling back to the saved manual model, the
 * recent list, the per-session scope model, or a provider default.
 */
export function managedAgentCurrentModel(
  agent: ManagedAgentShape & { model?: { providerID: string; modelID: string } | undefined } | undefined,
):
  | {
      providerID: string
      modelID: string
    }
  | undefined {
  if (!agent) return undefined
  if (!isManagedAgent(agent)) return undefined
  const model = agent.model
  if (!model) return undefined
  return { providerID: model.providerID, modelID: model.modelID }
}

/**
 * The TUI's per-agent manual model record. Keyed by the agent's `name`.
 */
export type AgentModelRecord = {
  [agentName: string]: { providerID: string; modelID: string }
}

/**
 * Compute the next per-agent manual model record when the user switches
 * to `target`.
 *
 * Spec #5: switching INTO a managed agent must clear any previously saved
 * manual model for that agent (the persistent per-agent model slot is
 * the TUI's "session/draft" state for this purpose). Switching INTO a
 * user-managed agent leaves the existing record alone so the user's
 * prior pick survives a managed round-trip.
 *
 * The function returns the next record; callers are expected to push the
 * result back into the Solid store. The decision is keyed on
 * `modelSelection`, never on the agent's name.
 */
export function resolveAgentSet(
  target: ManagedAgentShape & { name: string },
  current: AgentModelRecord,
): AgentModelRecord {
  if (!isManagedAgent(target)) return current
  if (!(target.name in current)) return current
  const next: AgentModelRecord = { ...current }
  delete next[target.name]
  return next
}

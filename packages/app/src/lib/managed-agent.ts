/**
 * Notice shown to the user when they try to switch model/provider/variant
 * while a managed agent is the current agent.
 *
 * Generic wording -- intentionally does not mention any specific agent name
 * so the same copy is correct for every managed (Adaptive-style) agent.
 */
export const MANAGED_AGENT_NOTICE =
  "This agent selects models automatically. Switch to a user-managed agent to choose a model manually."

/**
 * The minimum shape needed to decide whether an agent is "managed".
 *
 * The app consumes agent objects that come from two sources: the OpenCode
 * server's internal `Agent.Info`, and the SDK's wire-shape `Agent` (where
 * `modelSelection` is optional on the type but always normalized to a value
 * at runtime per Spec #6). Accepting this minimal structural shape lets
 * every call site pass the typed object directly without a
 * `Record<string, unknown>` cast.
 */
export type ManagedAgentShape = {
  modelSelection?: "user" | "managed"
}

/**
 * Returns true when the given agent selects its model automatically.
 *
 * A managed agent picks its model itself; the user must not be able to
 * switch its model, provider, or variant from the app. The decision is
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
 * Shape accepted by `resolveAgentSwitch`. Any object that names the agent
 * and optionally carries a model and variant will do.
 */
export type AgentSwitchTarget = ManagedAgentShape & {
  name: string
  model?: { providerID: string; modelID: string }
  variant?: string | null
}

/**
 * The minimal per-session / draft state used by the app's local model
 * selection. The variant slot accepts `null` to mean "cleared" while
 * `undefined` is reserved for "never set".
 */
export type AgentSwitchState = {
  agent?: string
  model?: { providerID: string; modelID: string; variant?: string } | undefined
  variant?: string | null
}

/**
 * Compute the next per-session / draft state when the user switches to
 * `target`.
 *
 * Spec #5:
 *   - Switching INTO a managed agent clears the manual model and variant
 *     pick (model: undefined, variant: null). The agent's configured
 *     `model` is what `current()` will surface; the prior user pick would
 *     be stale or wrong.
 *   - Switching INTO a user-managed agent keeps the prior user pick for
 *     that agent. The agent's configured `model` is the fallback when no
 *     prior pick exists.
 *
 * Extracted as a pure function so the policy is testable without a
 * Solid runtime.
 */
export function resolveAgentSwitch(
  target: AgentSwitchTarget,
  prev: AgentSwitchState | undefined,
): AgentSwitchState {
  if (isManagedAgent(target)) {
    return {
      agent: target.name,
      model: undefined,
      variant: null,
    }
  }
  return {
    agent: target.name,
    model: target.model ?? prev?.model,
    variant: target.variant ?? prev?.variant,
  }
}

/**
 * Compute the next per-session / draft state when restoring a session
 * from a stored user message.
 *
 * Spec #5: a managed agent must not pull a stale message-time `model`
 * into the local selection. The agent's configured `model` is what
 * `current()` will surface; the message `model` is only promoted for
 * user-managed agents.
 */
export function resolveSessionRestore(
  restoredAgent: ManagedAgentShape | undefined,
  msg: { agent: string; model: AgentSwitchState["model"] },
): AgentSwitchState {
  if (isManagedAgent(restoredAgent)) {
    return {
      agent: msg.agent,
      model: undefined,
      variant: null,
    }
  }
  return {
    agent: msg.agent,
    model: msg.model,
    variant: msg.model?.variant ?? null,
  }
}

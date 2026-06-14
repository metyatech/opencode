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
 * server's internal `Agent.Info`, and the SDK's wire-shape `Agent`. After
 * Spec #9 the wire type's `modelSelection` is always normalized to a value
 * (no longer `undefined`) at runtime. Accepting this minimal structural
 * shape lets every call site pass the typed object directly without a
 * `Record<string, unknown>` cast.
 */
export type ManagedAgentShape = {
  modelSelection: "user" | "managed"
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
 * consult: Spec #5 / Item #7 forbid falling back to the saved manual
 * model, the recent list, the per-session scope model, a provider default,
 * or the previous normal agent's model. A managed agent with no model
 * yields `current model = undefined`.
 */
export function managedAgentCurrentModel(
  agent: (ManagedAgentShape & { model?: { providerID: string; modelID: string } | undefined }) | undefined,
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
 * Per-normal-agent manual model/variant selection.
 *
 * `model` is the user-picked model for that agent; `variant` is the
 * user-picked variant (or `null` to mean "cleared"; `undefined` to mean
 * "never set"). Switching INTO a managed agent never deletes an entry
 * here -- the per-agent history is preserved so the user's prior pick
 * survives a managed round-trip.
 */
export type ManualAgentSelection = {
  model?: { providerID: string; modelID: string }
  variant?: string | null
}

/**
 * The per-agent manual pick history, keyed by the agent's `name`.
 *
 * `undefined` and missing keys both mean "no history for this agent";
 * the slot exists for the strict-record form the Solid store prefers.
 */
export type ManualAgentSelections = {
  [agentName: string]: ManualAgentSelection | undefined
}

/**
 * Keys of `ManualAgentSelection`. Exported for downstream code that
 * needs to enumerate or filter the slot without reaching into the
 * type.
 */
export const MANUAL_AGENT_SELECTION_KEYS = ["model", "variant"] as const

/**
 * The minimal per-session / draft state used by the app's local model
 * selection. The variant slot accepts `null` to mean "cleared" while
 * `undefined` is reserved for "never set".
 *
 * `manualByAgent` is the per-normal-agent manual pick history (Item
 * #8). It survives managed-agent round-trips and is the source of
 * truth for switching back to a normal agent.
 */
export type AgentSwitchState = {
  agent?: string
  model?: { providerID: string; modelID: string; variant?: string } | undefined
  variant?: string | null
  manualByAgent?: ManualAgentSelections
}

const cloneManual = (current: ManualAgentSelections | undefined): ManualAgentSelections => {
  if (!current) return {}
  const next: ManualAgentSelections = {}
  for (const key of Object.keys(current)) {
    const value = current[key]
    if (!value) continue
    next[key] = {
      ...(value.model ? { model: { ...value.model } } : {}),
      ...(value.variant !== undefined ? { variant: value.variant } : {}),
    }
  }
  return next
}

const writeManual = (
  current: ManualAgentSelections | undefined,
  name: string,
  selection: ManualAgentSelection | undefined,
): ManualAgentSelections => {
  const next = cloneManual(current)
  if (!selection) {
    delete next[name]
    return next
  }
  next[name] = {
    ...(selection.model ? { model: { ...selection.model } } : {}),
    ...(selection.variant !== undefined ? { variant: selection.variant } : {}),
  }
  return next
}

/**
 * Compute the next per-session / draft state when the user switches to
 * `target`.
 *
 * Spec #5 / Item #8:
 *   - Switching INTO a managed agent clears the active manual model
 *     and variant pick (model: undefined, variant: null) so the agent's
 *     own configured `model` is what `current()` surfaces. The
 *     `manualByAgent` history for OTHER agents is preserved; only the
 *     managed agent's own slot is touched (cleared, so a stale pick
 *     cannot leak back when the user re-switches to this managed agent
 *     later).
 *   - Switching INTO a user-managed agent restores the prior manual
 *     pick for THAT agent, with precedence:
 *       1) `manualByAgent[target.name]`
 *       2) the target agent's own configured model/variant
 *       3) the prior session/draft `model`/`variant` (kept so an
 *          in-flight session pick survives a managed round-trip when
 *          no per-agent history exists yet)
 *
 * Extracted as a pure function so the policy is testable without a
 * Solid runtime.
 */
export function resolveAgentSwitch(
  target: AgentSwitchTarget,
  prev: AgentSwitchState | undefined,
): AgentSwitchState {
  const manualByAgent = prev?.manualByAgent

  if (isManagedAgent(target)) {
    return {
      agent: target.name,
      model: undefined,
      variant: null,
      manualByAgent: writeManual(manualByAgent, target.name, undefined),
    }
  }

  const priorForTarget = manualByAgent?.[target.name]
  const priorModel = priorForTarget?.model ?? target.model ?? prev?.model
  const priorVariant =
    priorForTarget?.variant !== undefined
      ? priorForTarget.variant
      : target.variant !== undefined
        ? target.variant
        : prev?.variant

  return {
    agent: target.name,
    model: priorModel,
    variant: priorVariant,
    manualByAgent: cloneManual(manualByAgent),
  }
}

/**
 * Compute the next per-session / draft state when restoring a session
 * from a stored user message.
 *
 * Spec #5 / Item #8:
 *   - For a managed agent: do NOT promote the message-time `model`
 *     into the active state, and do NOT record it in `manualByAgent`.
 *     The agent's configured `model` is what `current()` will surface.
 *   - For a user-managed agent: promote the message-time `model` into
 *     the active state AND record the same pick in
 *     `manualByAgent[target]` so the user's prior pick survives a
 *     future managed-agent round-trip.
 *   - When the agent is unknown (not in the list), the message model
 *     is still kept in the active state so the caller can decide.
 */
export function resolveSessionRestore(
  restoredAgent: (ManagedAgentShape & { name?: string }) | undefined,
  msg: { agent: string; model: AgentSwitchState["model"] },
  prev: AgentSwitchState | undefined,
): AgentSwitchState {
  const manualByAgent = prev?.manualByAgent

  if (restoredAgent && isManagedAgent(restoredAgent)) {
    return {
      agent: msg.agent,
      model: undefined,
      variant: null,
      manualByAgent,
    }
  }

  return {
    agent: msg.agent,
    model: msg.model,
    variant: msg.model?.variant ?? null,
    manualByAgent: writeManual(manualByAgent, msg.agent, {
      ...(msg.model ? { model: { providerID: msg.model.providerID, modelID: msg.model.modelID } } : {}),
      ...(msg.model?.variant !== undefined ? { variant: msg.model.variant } : {}),
    }),
  }
}

/**
 * Compute the next per-session / draft state when the user picks a
 * model on the CURRENT (normal) agent.
 *
 * Item #8: the pick is recorded into `manualByAgent[currentAgent]`
 * so it survives a future managed-agent round-trip and wins over
 * the agent's own configured model the next time the user switches
 * back to this agent.
 */
export function resolveModelSelect(
  currentAgent: string,
  model: { providerID: string; modelID: string } | undefined,
  prev: AgentSwitchState | undefined,
): AgentSwitchState {
  const nextManual: ManualAgentSelection = model
    ? {
        model: { providerID: model.providerID, modelID: model.modelID },
        variant: prev?.manualByAgent?.[currentAgent]?.variant,
      }
    : {}
  return {
    ...(prev ?? { agent: currentAgent }),
    model,
    variant: prev?.variant,
    manualByAgent: writeManual(prev?.manualByAgent, currentAgent, nextManual),
  }
}

/**
 * Compute the next per-session / draft state when the user picks a
 * variant on the CURRENT (normal) agent.
 *
 * Item #8: the variant pick is recorded into
 * `manualByAgent[currentAgent].variant` so it survives a future
 * managed-agent round-trip.
 */
export function resolveVariantSelect(
  currentAgent: string,
  variant: string | null | undefined,
  prev: AgentSwitchState | undefined,
): AgentSwitchState {
  const priorForTarget = prev?.manualByAgent?.[currentAgent]
  const nextManual: ManualAgentSelection = {
    ...(priorForTarget?.model ? { model: { ...priorForTarget.model } } : {}),
    ...(variant !== undefined ? { variant } : {}),
  }
  return {
    ...(prev ?? { agent: currentAgent }),
    variant: variant ?? null,
    manualByAgent: writeManual(prev?.manualByAgent, currentAgent, nextManual),
  }
}

/**
 * Migrate a persisted `Saved.session[session]` payload that predates
 * the `manualByAgent` field. When the legacy `model` is set and the
 * `agent` is a normal agent, lift that pick into the new
 * `manualByAgent[agent]` slot so the user's last selection survives
 * the upgrade. When the migration cannot determine the agent type, it
 * keeps the original state intact (no wiping, no destructive change).
 */
export function migrateAgentSwitchState(
  value: AgentSwitchState | undefined,
  resolveAgent: (name: string) => ManagedAgentShape | undefined,
): AgentSwitchState | undefined {
  if (!value) return value
  if (value.manualByAgent) return value
  if (!value.agent) return value

  const next: AgentSwitchState = {
    ...value,
    manualByAgent: {},
  }
  const agent = resolveAgent(value.agent)
  if (!agent) return next
  if (isManagedAgent(agent)) return next
  if (!value.model) return next

  next.manualByAgent = writeManual(undefined, value.agent, {
    model: { providerID: value.model.providerID, modelID: value.model.modelID },
    ...(value.model.variant !== undefined ? { variant: value.model.variant } : {}),
  })
  return next
}

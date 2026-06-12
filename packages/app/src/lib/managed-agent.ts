/**
 * Notice shown to the user when they try to switch model/provider/variant
 * while a managed (Adaptive) agent is the current agent.
 */
export const MANAGED_AGENT_NOTICE =
  "Adaptive selects models automatically. Switch agents to choose a model manually."

/**
 * Returns true when the given agent is the managed (Adaptive) agent.
 *
 * A managed agent picks its model automatically; the user must not be
 * able to switch its model, provider, or variant from the app.
 *
 * Runtime agent objects in the app come from the SDK wire format and
 * from server-internal `Agent.Info`; both expose the optional
 * `modelSelection` discriminator, but the SDK type does not
 * (re-)declare it until the next SDK regeneration. We accept any object
 * and read the optional `modelSelection` field at runtime.
 */
export function isManagedAgent(agent: Record<string, unknown> | undefined): boolean {
  if (!agent) return false
  return (agent as { modelSelection?: "user" | "managed" }).modelSelection === "managed"
}

import { Effect } from "effect"
import type { PreparedInvocation } from "./invocation"

export const DEFAULT_TTL_MS = 30 * 60 * 1000

export const InvalidReason = {
  values: [
    "new-user-message",
    "compaction",
    "model-switch",
    "tool-started",
    "tool-result",
    "session-disposed",
    "ttl-expired",
    "retry-already-running",
    "assistant-activity",
  ] as const,
} as const

export type InvalidReason = (typeof InvalidReason.values)[number]

export const invalidReasons: ReadonlyArray<InvalidReason> = InvalidReason.values

export const isInvalidReason = (value: unknown): value is InvalidReason =>
  typeof value === "string" && (InvalidReason.values as ReadonlyArray<string>).includes(value)

export type InvocationCacheState = {
  bySession: Map<string, PreparedInvocation>
}

export const emptyState = (): InvocationCacheState => ({ bySession: new Map() })

export const publish = (state: InvocationCacheState, inv: PreparedInvocation): Effect.Effect<void> =>
  Effect.sync(() => {
    state.bySession.set(inv.sessionID, inv)
  })

export const get = (
  state: InvocationCacheState,
  sessionID: string,
  now: number = Date.now(),
): Effect.Effect<PreparedInvocation | undefined> =>
  Effect.sync(() => {
    const inv = state.bySession.get(sessionID)
    if (!inv) return undefined
    if (now - inv.createdAt > inv.ttlMs) {
      state.bySession.delete(sessionID)
      return undefined
    }
    return inv
  })

export const peek = (state: InvocationCacheState, sessionID: string): PreparedInvocation | undefined =>
  state.bySession.get(sessionID)

export const invalidate = (state: InvocationCacheState, sessionID: string, _reason: InvalidReason): Effect.Effect<void> =>
  Effect.sync(() => {
    state.bySession.delete(sessionID)
  })

export const clear = (state: InvocationCacheState): Effect.Effect<void> =>
  Effect.sync(() => {
    state.bySession.clear()
  })

export * as LLMInvocationCache from "./invocation-cache"

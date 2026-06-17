import { Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import { NonNegativeInt } from "@opencode-ai/core/schema"

export const OutputLengthError = NamedError.create("MessageOutputLengthError", {})

export const AuthError = NamedError.create("ProviderAuthError", {
  providerID: Schema.String,
  message: Schema.String,
})

/**
 * Watchdog timeout fired at the shared `LLMEvent` boundary. Replaces the
 * previous behavior where the stream silently stalled and the request ran
 * until the upstream HTTP deadline.
 *
 * - `first_event`: no normalized event arrived within
 *   `experimental.provider_request_timeout_ms` from subscription start.
 * - `stream_idle`: a normalized event arrived, but no further activity for
 *   the configured window — text/reasoning deltas, tool input, tool calls,
 *   step transitions, or provider error.
 */
export const ProviderRequestTimeoutError = NamedError.create("ProviderRequestTimeoutError", {
  message: Schema.String,
  phase: Schema.Literals(["first_event", "stream_idle"]),
  timeoutMs: NonNegativeInt,
  providerID: Schema.String,
  modelID: Schema.String,
})

export const Shared = [
  AuthError.EffectSchema,
  NamedError.Unknown.EffectSchema,
  OutputLengthError.EffectSchema,
  ProviderRequestTimeoutError.EffectSchema,
] as const
export const SharedSchema = Schema.Union(Shared)

export * as MessageError from "./message-error"

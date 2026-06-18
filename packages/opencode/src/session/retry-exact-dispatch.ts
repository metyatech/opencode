import { Context, Effect, Layer, Scope } from "effect"
import { Bus } from "@/bus"
import { Session } from "@/session/session"
import { SessionProcessor } from "./processor"
import { SessionRetryExact } from "./retry-exact"
import { SessionRunState } from "./run-state"
import { SessionStatus } from "./status"
import { MessageV2 } from "./message-v2"
import { MessageID } from "./schema"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { InstanceState } from "@/effect/instance-state"

// Dispatch ties the exact-replay eligibility check, the per-session runner
// claim, the assistant-message creation, and the processor pipeline into a
// single exclusive operation. It exists as its own module (rather than on
// `SessionRetryExact`) because it depends on `SessionProcessor`, which in turn
// depends on `SessionRetryExact`; keeping dispatch as a leaf avoids a layer
// cycle. The HTTP handler calls `dispatch` and returns the typed union as-is.
export interface Interface {
  readonly dispatch: (
    input: SessionRetryExact.RetryExactInput,
  ) => Effect.Effect<SessionRetryExact.RetryExactResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRetryExactDispatch") {}

const live: Layer.Layer<
  Service,
  never,
  | SessionRetryExact.Service
  | SessionProcessor.Service
  | SessionRunState.Service
  | SessionStatus.Service
  | Session.Service
  | Provider.Service
  | Bus.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const retryExact = yield* SessionRetryExact.Service
    const processor = yield* SessionProcessor.Service
    const runState = yield* SessionRunState.Service
    const statusSvc = yield* SessionStatus.Service
    const session = yield* Session.Service
    const provider = yield* Provider.Service
    const bus = yield* Bus.Service

    const dispatch = Effect.fn("SessionRetryExactDispatch.dispatch")(function* (
      input: SessionRetryExact.RetryExactInput,
    ) {
      // 1. Eligibility + reserve the prepared invocation under the
      //    per-session exact lock. A losing concurrent exact retry is
      //    rejected here with `retry-already-running`.
      const claim = yield* retryExact.claim(input)
      if (claim.accepted === false) return claim
      const prepared = claim.prepared

      const rejected = (
        reason: SessionRetryExact.RetryExactRejectionReason,
      ): SessionRetryExact.RetryExactRejection => ({
        accepted: false,
        reason,
        fingerprint: prepared.fingerprint,
        ...(prepared.promptCacheKey ? { promptCacheKey: prepared.promptCacheKey } : {}),
      })

      // 2. Read-only lookups. These create no state, so a failure simply
      //    releases the exact lock and returns a synchronous rejection.
      const userMessage = yield* MessageV2.get({
        sessionID: input.sessionID,
        messageID: prepared.userID as MessageID,
      }).pipe(Effect.orElseSucceed(() => undefined))
      if (!userMessage || userMessage.info.role !== "user") {
        yield* retryExact.release(input.sessionID)
        return rejected("no-prepared-invocation")
      }
      const model = yield* provider
        .getModel(prepared.provider.providerID as ProviderID, prepared.provider.modelID as ModelID)
        .pipe(Effect.orElseSucceed(() => undefined))
      if (!model) {
        yield* retryExact.release(input.sessionID)
        return rejected("model-mismatch")
      }

      const ctxInstance = yield* InstanceState.context
      const userInfo = userMessage.info

      const skeleton = (): MessageV2.Assistant => ({
        id: MessageID.ascending(),
        parentID: userInfo.id,
        role: "assistant",
        mode: "primary",
        agent: userInfo.agent ?? "build",
        ...(prepared.provider.variant ? { variant: prepared.provider.variant } : {}),
        path: { cwd: ctxInstance.directory, root: ctxInstance.worktree },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.id,
        providerID: model.providerID,
        time: { created: Date.now() },
        sessionID: input.sessionID,
      })

      // The runner cancel path interrupts the work fiber directly; the
      // processor's own interrupt handler finalizes the assistant message.
      // This onInterrupt only needs to yield a valid `WithParts` for the
      // runner's await/translation machinery (unobserved on the detached
      // claim path).
      const onInterrupt: Effect.Effect<MessageV2.WithParts> = Effect.gen(function* () {
        const messages = yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orElseSucceed(() => []))
        const last = [...messages].reverse().find((m) => m.info.role === "assistant")
        return last ?? ({ info: skeleton(), parts: [] } as MessageV2.WithParts)
      })

      // 3. The whole mutating pipeline runs as the runner's exclusive work.
      //    Assistant-message creation, processor wiring, and
      //    `processPrepared` all live inside, so a busy runner means none of
      //    this runs and no orphan state is created. `ensuring(release)`
      //    covers every post-claim failure path (assistant creation,
      //    processor creation, dispatch errors, abort, fiber interrupt).
      const work: Effect.Effect<MessageV2.WithParts, never, Scope.Scope> = Effect.gen(function* () {
        const assistantMessage = skeleton()
        return yield* Effect.gen(function* () {
          yield* session.updateMessage(assistantMessage)
          const handle = yield* processor.create({
            assistantMessage,
            sessionID: input.sessionID,
            model,
          })
          yield* handle.processPrepared(prepared)
          return yield* MessageV2.get({ sessionID: input.sessionID, messageID: assistantMessage.id }).pipe(
            Effect.orElseSucceed(() => ({ info: assistantMessage, parts: [] }) as MessageV2.WithParts),
          )
        }).pipe(
          Effect.catch((error: unknown) =>
            Effect.gen(function* () {
              yield* bus.publish(Session.Event.Error, {
                sessionID: input.sessionID,
                messageID: assistantMessage.id,
                parentID: assistantMessage.parentID,
                agent: assistantMessage.agent,
                model: {
                  providerID: assistantMessage.providerID,
                  modelID: assistantMessage.modelID,
                  ...(assistantMessage.variant ? { variant: assistantMessage.variant } : {}),
                },
                error: MessageV2.fromError(error, {
                  providerID: assistantMessage.providerID,
                  aborted: false,
                }),
              })
              return { info: assistantMessage, parts: [] } as MessageV2.WithParts
            }),
          ),
        )
      }).pipe(Effect.ensuring(retryExact.release(input.sessionID)))

      // 4. Atomic runner claim. Losing to a concurrent normal prompt/retry/
      //    shell (or an exact retry that already claimed the runner between
      //    our eligibility check and here) means the work never starts.
      const claimed = yield* runState.claimExclusive(input.sessionID, onInterrupt, work)
      if (!claimed) {
        yield* retryExact.release(input.sessionID)
        return rejected("retry-already-running")
      }

      yield* statusSvc.set(input.sessionID, { type: "busy" })
      yield* bus.publish(
        SessionRetryExact.ExactReplayEvent,
        SessionRetryExact.ExactReplayPayload.make({
          sessionID: input.sessionID,
          ...(input.messageID ? { messageID: input.messageID } : {}),
          providerID: prepared.provider.providerID,
          modelID: prepared.provider.modelID,
          ...(prepared.provider.variant ? { variant: prepared.provider.variant } : {}),
          fingerprint: prepared.fingerprint,
          ...(prepared.promptCacheKey ? { promptCacheKey: prepared.promptCacheKey } : {}),
          attempt: 1,
        }),
      )

      return {
        accepted: true as const,
        fingerprint: prepared.fingerprint,
        ...(prepared.promptCacheKey ? { promptCacheKey: prepared.promptCacheKey } : {}),
      }
    })

    return Service.of({ dispatch })
  }),
)

export const layer = live

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRetryExact.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Bus.layer),
  ),
)

export * as SessionRetryExactDispatch from "./retry-exact-dispatch"

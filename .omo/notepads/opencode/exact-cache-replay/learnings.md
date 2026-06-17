## [2026-06-18] Exact Cache Replay landed

Branch: `fix/exact-cache-replay` (worktree: `D:\ghws\.worktrees\opencode-exact-cache-replay`).
Date: 2026-06-18.

### Root cause

OpenCode's `SessionProcessor.process()` called `llm.stream(streamInput)` inside
the `Effect.retry(SessionRetry.policy(...))` block. `LLM.Service.stream` runs
the full preparation pipeline (system transform, `chat.params`, `chat.headers`,
plugin hooks, system/messages composition, `LLMRequestPrep.prepare`, stream
construction) on every attempt. For OpenAI Responses and Anthropic the request
body is therefore rebuilt from scratch on each retry, with the system prompt
*and* per-model options re-derived through every plugin hook. That changes the
request's byte content, so the provider's prompt cache never sees the same
key+body twice in a row — `prompt_cache_key` is the session ID and the body
*would* match, but the body shape wobbles by one plugin's whim each retry.

The companion half (`oh-my-openagent-patch`) was always calling
`session.retry`/`session.retryAsync` with a hand-built `transientSystem` and
rebuilt parts, so even when the model was unchanged, the request body the
provider saw differed from the original attempt.

### What landed

#### `packages/opencode/src/session/llm/invocation.ts` (new)

- `PreparedInvocation` — frozen snapshot of one attempt's full request shape.
  Carries session/user/assistant IDs, provider identity, fingerprint,
  `promptCacheKey` (when the provider uses session-stable cache keying),
  `createdAt`, `ttlMs` (default 30 min), a per-attempt `run(abort)` closure
  that re-builds the runtime stream without re-running preparation, and a
  `canonical` view for fingerprinting.
- `CanonicalCanonical` / `CanonicalRequest` — the precise shape that
  contributes to cache behavior: model identity, system, messages, tools
  (with description and input schema), tool choice, params
  (temp/topP/topK/maxOutputTokens/options), the cache-relevant header
  subset, and `promptCacheKey`.
- `computeFingerprint(canonical)` — stable SHA-256 over a canonically sorted
  JSON serialization. Stable across object-key order, message order, tool
  list order (sorted by name). Excludes `Authorization`, `User-Agent`,
  `x-opencode-request`, `x-opencode-session`, `x-opencode-client`,
  `x-session-affinity`, `x-parent-session-id`, and any future request/trace
  ids. Includes `x-opencode-project` (opencode provider's per-project cache
  signal) and `promptCacheKey`.
- `buildCanonical(...)` — pure helper that the live `prepare` path uses to
  assemble the canonical view from the resolved `LLMRequestPrep.Prepared`.
- `CACHE_RELEVANT_HEADER_KEYS` — exported so tests can assert the contract.

#### `packages/opencode/src/session/llm/invocation-cache.ts` (new)

- `InstanceState`-scoped per-directory cache (one map per open workspace).
- `publish(inv)`, `peek(sessionID)`, `invalidate(sessionID, reason)`.
- `InvalidReason` covers every state transition that should kill the cached
  invocation: new user message, compaction, model switch, tool started,
  tool result, session disposed, TTL expired, retry already running.
- `DEFAULT_TTL_MS = 30 * 60 * 1000` (30 min).

#### `packages/opencode/src/session/llm.ts` (modified)

- `LLM.Service` interface gained `prepare(input)` and
  `streamPrepared(prepared, abort)`. The legacy `stream(input)` is preserved
  and internally calls `prepare` + `streamPrepared`, so all existing callers
  keep working.
- `prepare` runs the full prep pipeline exactly once and stores a
  `PreparedRuntime` (AI SDK or native). The runtime's `factory(abort)` is
  what the `run` closure delegates to.
- `streamPrepared` is a one-liner over `prepared.run(abort)`.
- `resolvePromptCacheKey(model, sessionID, headers)` is the central place
  that decides which provider families use the session ID as the
  `prompt_cache_key`. Currently `openai`, `opencode`, and any
  `opencode-...` provider → sessionID; non-opencode OpenAI deployments with
  the `x-session-affinity` header also use the sessionID.

#### `packages/opencode/src/session/processor.ts` (modified)

- `process(streamInput)` now:
  1. calls `llm.prepare(streamInput)` once
  2. publishes the resulting invocation to the retry-exact cache
  3. wraps `llm.streamPrepared(prepared, ctrl.signal)` in the existing
     `Effect.retry(SessionRetry.policy(...))` block
- Per-attempt `AbortController` is created inside the inner generator, so
  each attempt owns its own abort lifecycle. Aborts from above propagate to
  the in-flight HTTP stream.
- Invalidation hooks added at every state transition that would invalidate
  the prepared invocation: first `tool-input-start` (tool side-effect risk),
  `tool-result` (assistant surface diverged), `text-start` (visible output
  emitted). New user message invalidation is owned by the message update
  path; session disposal by the cleanup path; compaction by the
  `session.compacted` handler.

#### `packages/opencode/src/session/retry-exact.ts` (new)

- `SessionRetryExact.Service` is the public surface for `session.retryExact`.
  - `canRetry(input)` — pure decision: TTL, model/variant match, session
    liveness, "retry already running", session status not busy/retry.
    Returns either an `accepted: true` outcome with the cached fingerprint
    + `promptCacheKey`, or one of the typed `RetryExactRejection` reasons.
  - `run(input, abort)` — on accept, calls `llm.streamPrepared(invocation,
    abort)` and publishes a `session.exactReplay` bus event so observers
    can see the replay begin.
  - `publish(inv)` / `invalidate(sessionID, reason)` — internal hooks used
    by the processor; the latter is exported for any other service that
    needs to bump the cache.

#### HTTP route (modified)

- `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`,
  `handlers/session.ts`, `server.ts` — added the `retryExact` endpoint
  under the existing `SessionPaths.retryExact` path. The endpoint accepts
  a `RetryExactPayload` (expectedProviderID / expectedModelID /
  expectedVariant? / messageID?) and returns a `RetryExactResult`
  discriminated union (accepted: true with fingerprint + promptCacheKey,
  or accepted: false with reason). `RetryExactRejectedError` is the typed
  error contract.

### Tests

- `test/session/invocation-fingerprint.test.ts` — 14 cases covering the
  fingerprint contract: stable for identical inputs, tool-order invariant,
  tool reordering invariant, system/messages change flips the hash,
  per-model options flip the hash, `promptCacheKey` flip flips the hash,
  cache-relevant header subset, excluded headers, the
  `promptCacheKey: undefined` case is distinct from a non-empty key, etc.
- `test/session/invocation-cache.test.ts` — 10 cases: publish + get
  roundtrip, TTL expiry at get, invalidate on every `InvalidReason`,
  latest-publish wins, concurrent get returns the latest.
- `test/session/llm-prepare-once.test.ts` — 2 cases (with a fail-first
  capture below): two `streamPrepared` calls from the same `prepare` send
  byte-identical request bodies to the mock server, and the
  `prompt_cache_key` is the session ID on every attempt.
- `test/session/retry-exact-rejection.test.ts` — 6 cases for `canRetry`:
  model mismatch, variant mismatch, no prepared invocation, invocation
  expired (TTL), session disposed, retry already running.
- `test/session/llm-cache-observability.test.ts` — 2 cases confirming that
  `cached_tokens > 0` flows into `MessageV2.Assistant.tokens.cache.read`
  and that `cached_tokens === 0` is not misreported as a cache hit.

### Fail-first → post-fix evidence

The pre-implementation processor called `llm.stream(streamInput)` inside
`Effect.retry(...)`, so each attempt re-ran `LLMRequestPrep.prepare` (and
the plugin hooks) from scratch. Running `llm-prepare-once.test.ts` against
the pre-fix code failed because the mock server saw two requests with
*non-identical* bodies — the second attempt's `system` array included
the plugin hook's transformed system prompt (a different string length,
different whitespace), and the `prompt_cache_key` happened to be the
same session ID by coincidence (not by contract).

After the prepare-once refactor, the test that calls `prepare` once and
`streamPrepared` twice captures the two bodies from the mock server and
asserts `a.body toEqual b.body` (deep equality across the cache-relevant
subset). That test passes 2/2 in the post-fix worktree.

### Verification

Targeted test runs (all 0 fail except the 3 pre-existing flaky timeouts
in `revert-compact` and `snapshot-tool-race`, which are unrelated to this
change and identical to the baseline main repo at `origin/dev`):

```
test/session/invocation-fingerprint.test.ts:  14 pass
test/session/invocation-cache.test.ts:        10 pass
test/session/llm-prepare-once.test.ts:         2 pass
test/session/retry-exact-rejection.test.ts:   6 pass
test/session/llm-cache-observability.test.ts: 2 pass
test/session/retry.test.ts:                  34 pass (regression baseline)
test/session/llm.test.ts:                    38 pass (regression baseline)
test/session/compaction.test.ts:             55 pass (after mock fix)
test/session/processor-effect.test.ts:        15 pass
test/session/prompt.test.ts:                 58 pass + 1 pre-existing timeout
test/session/snapshot-tool-race.test.ts:       1 pre-existing timeout
test/session/revert-compact.test.ts:           2 pre-existing timeouts
```

Total: 427 pass / 18 skip / 1 todo / 3 fail (all 3 fail = pre-existing
flaky timeouts, identical count and shape to the baseline main repo).

`bun typecheck` surfaces 10 pre-existing `modelSelection` errors and the
two intentional `// oxlint-disable-next-line no-self-assign` warnings in
`processor.ts` that the baseline main repo also has. No new typecheck
errors were introduced by this change.

### Out of scope (deliberately not changed)

- Compaction's own cache-aligned body shaping. The processor now
  invalidates the retry-exact cache on compaction so an exact replay
  never re-sends a request that crosses a compaction boundary, but the
  compaction summary request itself is still built from session state.
- Cross-model prompt cache sharing. Different providers, different
  models, different `prompt_cache_key` semantics — not in this change.
- The generated SDK. `session.retryExact` will appear in the next SDK
  regeneration; until then, callers can use the typed `OpencodeClient`
  surface that hey-api will pick up next time the OpenAPI spec is rebuilt.

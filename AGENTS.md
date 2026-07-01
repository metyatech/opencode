<!-- markdownlint-disable MD025 -->
# Tool Rules (compose-agentsmd)

- **Session gate**: before starting substantive work for each externally supplied human/operator instruction, run `compose-agentsmd` once from the project root. AGENTS.md contains the rules you operate under; stale rules cause rule violations. Do not rerun this gate within the same instruction after tool results, retries, generated continuations, or resumed execution. If you discover you skipped this step mid-session, stop, run it immediately, re-read the diff, and adjust your behavior before continuing.
- `compose-agentsmd` intentionally regenerates `AGENTS.md`; any resulting `AGENTS.md` diff is expected and must not be treated as an unexpected external change.
- If `compose-agentsmd` is not available, run it via `npx compose-agentsmd`. If `npx` is unavailable or cannot fetch the package, install it via npm with an environment-appropriate method such as `npm install -g compose-agentsmd` when global installs are permitted, or a user-local npm prefix when global installs are not permitted.
- To update shared/global rules, use `compose-agentsmd edit-rules` to locate the writable rules workspace, make changes only in that workspace, then run `compose-agentsmd apply-rules` (do not manually clone or edit the rules source repo outside this workflow).
- If you find an existing clone of the rules source repo elsewhere, do not assume it is the correct rules workspace; always treat `compose-agentsmd edit-rules` output as the source of truth.
- `compose-agentsmd apply-rules` pushes the rules workspace when `source` is GitHub (if the workspace is clean), then regenerates `AGENTS.md` with refreshed rules.
- Do not edit `AGENTS.md` directly; update the source rules and regenerate.
- `tools/tool-rules.md` is the shared rule source for all repositories that use compose-agentsmd.
- Before applying any rule updates, present the planned changes first with an ANSI-colored diff-style preview, ask for explicit approval, then make the edits.
- These tool rules live in tools/tool-rules.md in the compose-agentsmd repository; do not duplicate them in other rule modules.

Source: github:metyatech/agent-rules@HEAD/rules/domains/agent-tooling/composition.md

# Agent Tooling Composition

- Agent tooling repositories MUST keep generated instruction files reproducible from `agent-ruleset.json` and the selected profile.
- Agent tooling repositories MUST NOT rely on repo-local `agent-rules-local` rule files.
- Rule source changes MUST be made in `rules/global/`, `rules/domains/`, or `agent-profiles.json`.
- Generated `AGENTS.md` and `CLAUDE.md` diffs MUST be reviewed as generated instruction diffs, not hand-edited.
- If a generated instruction file is stale, regenerate it with `compose-agentsmd` or the repository's canonical compose command before reporting completion.
- A profile MUST select the complete set of domains needed by a repository type; consuming repositories MUST NOT compensate by listing domains or local extras.

Source: github:metyatech/agent-rules@HEAD/rules/domains/opencode/repository.md

# OpenCode Repository Rules

## Repository workflow

- The default branch in this repository is `dev`.
- Local `main` may not exist; use `dev` or `origin/dev` for diffs when no other branch is specified.
- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- Prefer automation: execute requested actions without confirmation unless blocked by missing information, safety, or irreversibility.
- Repository-local OpenCode workflows MUST live in `.opencode/commands/`.
- The canonical verification command MUST be the same command used for local validation before delivery.
- When no canonical verification command is configured, stop and report the missing bootstrap requirement instead of inventing a partial substitute.
- Bug fixes MUST add or strengthen a regression check before concluding.
- Irreversible operations such as destructive deletion, publish, release, force-push, or external side effects MUST remain approval-gated.

## Style guide

- Keep things in one function unless code is composable or reusable.
- Avoid `try` / `catch` where possible.
- Avoid the `any` type.
- Use Bun APIs when possible, such as `Bun.file()`.
- Rely on type inference when possible.
- Avoid explicit type annotations or interfaces unless necessary for exports or clarity.
- Prefer functional array methods such as `flatMap`, `filter`, and `map` over for loops.
- Use type guards on `filter` to maintain downstream type inference.
- Reduce total variable count by inlining a value when it is only used once.
- Avoid unnecessary destructuring; use dot notation to preserve context.
- Prefer `const` over `let`.
- Use ternaries or early returns instead of reassignment.
- Avoid `else`; prefer early returns.

## Drizzle schema definitions

- Use snake_case for Drizzle field names so column names do not need to be redefined as strings.

## Testing and type checking

- Avoid mocks as much as possible.
- Test the actual implementation; do not duplicate logic into tests.
- Tests MUST NOT run from the repository root.
- Run tests from package directories such as `packages/opencode`.
- Always run `bun typecheck` from package directories such as `packages/opencode`.
- Do not run `tsc` directly for this repository's package type checking.

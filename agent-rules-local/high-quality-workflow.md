# High-quality OpenCode workflow

- Repository-local OpenCode workflows MUST live in `.opencode/commands/`.
- The canonical verification command MUST be the same command used for local validation before delivery.
- When no canonical verification command is configured, the agent MUST stop and report the missing bootstrap requirement instead of inventing a partial substitute.
- Bug fixes MUST add or strengthen a regression check before concluding.
- Irreversible operations such as destructive deletion, publish, release, force-push, or external side effects MUST remain approval-gated.

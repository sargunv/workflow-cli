# Roadmap

Not supported yet:

- **Budget enforcement.** `budget.total` is `null`, `spent()` is `0` and
  `remaining()` is `Infinity`; token usage is still reported. A hard ceiling
  needs reliable per-backend accounting, and budget observations must be
  recorded so resumed runs replay the same decisions.
- **`agentType`.** There is no harness-specific agent registry. Use config
  profiles instead; passing `agentType` fails.
- **MCP passthrough.** Scripts cannot attach MCP servers to leaf agents; a leaf
  gets only what its harness configures on its own.
- **Native Windows.** Process cleanup relies on POSIX process groups. Windows
  needs equivalent Job Object ownership; until then use WSL.
- **npm release.** Install from a checkout until the package is published
  ([#8](https://github.com/sargunv/workflow-cli/issues/8)).

## Run observation

Planned milestones for making long runs observable from the CLI and host apps:

1. [#12](https://github.com/sargunv/workflow-cli/issues/12): define and persist
   one status, milestone and transcript contract shared by every surface.
2. [#13](https://github.com/sargunv/workflow-cli/issues/13): normalize agent
   activity (action, target paths, tool status) across backends.
3. [#14](https://github.com/sargunv/workflow-cli/issues/14): unify CLI progress,
   periodic status lines and a bounded `workflow-cli status` snapshot.
4. [#15](https://github.com/sargunv/workflow-cli/issues/15): add a dashboard,
   status-line and completion-delivery adapters for host apps.
5. [#16](https://github.com/sargunv/workflow-cli/issues/16): verify the
   observation contract end to end and document it.

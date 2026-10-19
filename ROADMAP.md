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

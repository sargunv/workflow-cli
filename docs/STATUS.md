# Status

The VISION.md implementation is complete: plain-JavaScript scripts in an
isolated QuickJS sandbox, barrier-free `pipeline`/`parallel` orchestration,
longest-unchanged-prefix resume, structured output with bounded corrections,
Claude/Codex/Cursor CLI drivers and OpenCode/Kimi/Qwen ACP drivers, worktree
isolation with opt-in shared paths, background runs with stop/skip/wait
controls, and the bundled authoring skill with runnable recipes.

Deferred by design (see DECISIONS.md): real `budget` accounting (`total` stays
`null`), a harness `agentType` registry (use `profile`), and MCP passthrough.

Not yet observed: remote CI. All validation so far is local.

Verify with `mise run check`, `mise run typecheck`, `mise run test`, and `mise
run build`. The offline suite uses fixtures and synthetic executables only;
`mise run probe` is the separate manual target for real backends and consumes
quota. See [MAINTENANCE.md](MAINTENANCE.md) for ownership boundaries and the
validation map.

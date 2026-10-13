# Vision

A standalone CLI for orchestrating multi-agent workflows across any coding
agent harness.

Claude Code has a "dynamic workflows" feature: the model writes a JavaScript
script that fans work out to subagents, verifies results adversarially, loops
until convergence, and returns structured data. This project lifts that shape
out into a CLI that is independent of any harness and can drive any agent as a
leaf worker: Claude Code, Codex, OpenCode, Kimi, Cursor, and whatever comes
next.

The orchestration layer is deterministic code. The leaf work is model-driven.
Only the leaf work should care which vendor is on the other end.

## What it keeps from the reference

Functional parity with the Claude Code Workflow tool: the `meta` header, the
deterministic sandbox (no filesystem, process, network, clock, or random
APIs), the injected globals `agent`, `pipeline`, `parallel`, `phase`, `log`,
`args`, `budget`, and `workflow`, the journal, and longest-unchanged-prefix
resume. Scripts written for the reference tool should run here with at most
the addition of a backend selection. The bundled skill in `skills/workflow/`
is the authoritative script-authoring contract.

## What it changes

- Scripts are files, run with `workflow run ./script.js`; `--resume` replays
  the longest unchanged prefix of a prior run.
- `workflow info` reports the backends, models, effort levels, structured
  output strategies, and tool policies available on this machine, so scripts
  never name a backend or model that is not installed.
- Backends are explicit per agent and per run. Claude, Codex, Cursor, and Muse
  use their headless CLIs; OpenCode, Kimi, and Qwen use native ACP. Backend
  differences are absorbed in drivers, never in the script API.
- Agents always run without approval prompts. Read-only tool policies and
  worktree isolation are the mitigations; a container or VM is the recommended
  posture for untrusted repositories.
- Output is built for a model caller: compact progress and completion reports,
  large results spilled to files, and inspection as separate commands.

## Deferred

Real `budget` accounting, a harness `agentType` registry (profiles are the
equivalent), and MCP passthrough. See [STATUS.md](docs/STATUS.md) for current
state and [DECISIONS.md](DECISIONS.md) for rationale and reversal criteria.

# Workflow

A standalone CLI for deterministic JavaScript orchestration across coding agent
harnesses.

## Project map

- `VISION.md`: product requirements and reference behavior.
- `BACKENDS.md`: observations from real vendor binaries, dated and versioned.
- `src/runtime/`: script parsing, sandbox, replay, agent lifecycle.
- `src/drivers/`: vendor-independent interface, CLI and ACP transports.
- `skills/workflow/`: bundled authoring documentation.
- `examples/`: runnable workflow recipes.
- `test/`: offline behavior tests and recorded protocol fixtures.
- `DECISIONS.md`: deliberate deviations, rationale, and reversal criteria.
- `docs/STATUS.md`: implementation and verification tracking.

## Dev tool commands

Use `mise install` then `mise run build`, `mise run test`, and `mise run check`.
Run the source CLI with `mise run dev -- <arguments>`. Tests must never invoke
real agent binaries. Live probes are separate and consume quota. For reference
Workflow behavior, query `claude` CLI with the `claude-opus-5` model.

## Project invariants

- Replay preserves observable completion order without inserting pipeline
  barriers.
- No filesystem, process, network, or nondeterministic clock/random APIs enter
  the script VM.
- Schema validation preserves the caller's schema; native driver adaptation must
  not silently narrow it.
- Null agent results carry a persisted reason. Requested tool restrictions fail
  closed.
- Cancellation closes admission before terminating owned processes and
  preserving changed worktrees.

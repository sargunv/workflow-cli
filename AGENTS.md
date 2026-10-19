# Workflow

A standalone CLI for deterministic JavaScript orchestration across coding agent
harnesses. The user-facing overview is in README.md; the script API is in
`skills/workflow/SKILL.md`.

## Project map

- `src/runtime/`: script parsing, sandbox, replay, agent lifecycle.
- `src/drivers/`: vendor-independent interface, CLI and ACP transports.
- `skills/workflow/`: bundled authoring skill.
- `examples/`: runnable workflow recipes.
- `test/`: offline behavior tests and recorded protocol fixtures.
- `scripts/`: build, example formatting, package smoke test and the manual
  backend probe.

| Area              | Owner and boundary                                                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root run          | `src/runtime/run.ts` admits calls, assigns IDs, shares discovery/concurrency, prepares child scripts, drives replay and persists final records.                                                                                                      |
| Live leaf         | `src/runtime/agent.ts` owns one agent's worktree, correction session, attempts and cleanup. Its `run()` shows acquisition through unconditional lease release. Root callbacks enforce persistence failures.                                          |
| Replay            | `src/runtime/replay.ts` matches the previous trace and schedules delivery. Pending entries are keyed by previous-run IDs; current invocation IDs belong to the new journal.                                                                          |
| Sandbox           | `GuestSession` in `src/runtime/sandbox.ts` owns the QuickJS runtime, handles, bridge and job pump. `guest.js` installs the script API inside a private guest closure, removes temporary globals, and returns private settlement handles to the host. |
| Transports        | `src/drivers/cli.ts` builds vendor arguments and runs CLI attempts. `events.ts` normalizes their wire formats. `acp.ts` owns retained sessions and applies model, mode, then effort against refreshed capabilities.                                  |
| Process ownership | `src/drivers/process.ts` handles streams and bounded shutdown. `supervisor.cjs` owns the backend process group independently, including when the parent dies.                                                                                        |
| Presentation      | `src/progress.ts` owns live terminal rows. `output.ts` prepares report artifacts and formats summaries. `info.ts` collects and formats installation capabilities. `cli.ts` wires commands to these operations.                                       |

## Dev tool commands

Use `mise install`, then `mise run check`, `mise run typecheck`, `mise run test`
and `mise run build`; `mise run fix` formats. Run the source CLI with `mise run
dev -- <arguments>`. Tests must never invoke real agent binaries; they use
synthetic executables under `test/helpers/` and recorded fixtures. `mise run
smoke` packs and installs the package, then runs it against the fake Claude CLI;
CI runs it after the other checks. `mise run probe -- --backend <name> --model
<model>` checks one real backend manually and consumes quota.

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

## Design notes

- **Sandbox.** Scripts run in QuickJS compiled to WebAssembly. Only JSON crosses
  the host bridge, and there is no module loader or host filesystem, process,
  timer or network binding. A Node `vm` context does not give the same
  separation.
- **Replay order.** `replay.jsonl` records deliveries as well as starts, and
  replay follows the prior delivery order; resolving cached calls in invocation
  order would change later prompts when agents originally finished out of order.
  Replay preparation holds keep cached deliveries from racing script and child
  setup; release them before awaiting child execution. The first mismatch
  switches the rest of the run to live execution.
- **Failure kinds.** An agent failure becomes a null result with a persisted
  reason and stays cached on resume. Root persistence failures and uncertain
  process ownership terminate the run. A skipped agent replays as null, while a
  root-cancelled invocation is unfinished and runs again on resume. Keep these
  cases distinct when moving error handling.
- **Schemas.** Output is validated against the caller's draft-07 schema without
  coercion, defaults or stripping. Codex uses native output only when the schema
  already meets its strict requirements. Corrections never resend the task: ACP
  sends validation feedback in the retained session, and CLI drivers run a fresh
  read-only formatting turn with the prior result, error and schema.
- **ACP backends.** One native ACP server process per leaf bounds crash and
  cancellation effects to one agent. ACP has no schema facility or enforceable
  tool policy, so output is prompted and restrictions fail closed. Discovery
  opens an empty session without prompting because model-dependent settings are
  only visible there.
- **Static and computed references.** Literal backends, profiles and child
  scripts are preflighted before leaf work; computed ones are checked at first
  use so children generated by an earlier agent work. Resume prefers current
  child source and falls back to the prior run's archive only when the original
  is gone.
- **Process ownership.** Each backend runs under `supervisor.cjs`, which anchors
  a process group and kills it when the vendor exits or the owner's IPC
  connection dies. This avoids PID registries; background run control uses a
  token-authenticated loopback connection, never a stored PID. Descendants that
  start new sessions escape the group; this is not an OS sandbox.
- **Journal matching.** Cached outcomes match on all agent options (including
  labels and phases), effective runtime settings and cwd, so a changed execution
  contract never silently reuses an old result. Old run artifacts must stay
  readable because resumed runs link to cached transcripts.
- **Cursor results.** Cursor's terminal result aggregates earlier narration, so
  the final assistant message after tool activity is the return value.

## Source layout

Separate class members and top-level declarations with a blank line. Put public
lifecycle methods before private implementation helpers. Within methods, use
logical paragraphs for preparation, validation, execution and cleanup; keep
related assignments together. Formatters preserve these boundaries rather than
inventing them, so review must check them. Comments should explain ownership,
ordering, policy or a non-obvious constraint, not restate the adjacent code.

Lint requires braces, separate variable declarations and no nested ternaries.
Prefer direct control flow and named intermediate decisions over generic helper
frameworks. `prepareReport()` may write `result.json`; `formatReport()` only
renders. Keep disk writes visible at the call site.

`guest.js` runs inside QuickJS and `supervisor.cjs` in a separate Node process;
edit them directly. `scripts/build.ts` syntax-checks both and copies them into
`dist` unchanged.

Examples use top-level `return`, which the module formatter rejects, so
`scripts/format-examples.ts` wraps each body in an async function, formats it
with dprint and unwraps it. `mise run fix` and `mise run check` include this
step. `test/examples.test.ts` executes the recipes with controlled agent
results.

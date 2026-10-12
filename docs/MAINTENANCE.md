# Maintaining Workflow

Start with the owner of the behavior you are changing. The runtime uses ordinary
functions and a few stateful classes; there is no lifecycle or command
framework.

| Area              | Owner and boundary                                                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root run          | `src/runtime/run.ts` admits calls, assigns IDs, shares discovery/concurrency, prepares child scripts, drives replay and persists final records.                                                                                                      |
| Live leaf         | `src/runtime/agent.ts` owns one agent's worktree, correction session, attempts and cleanup. Its `run()` shows acquisition through unconditional lease release. Root callbacks enforce persistence failures.                                          |
| Replay            | `src/runtime/replay.ts` matches the previous trace and schedules delivery. Pending entries are keyed by previous-run IDs; current invocation IDs belong to the new journal.                                                                          |
| Sandbox           | `GuestSession` in `src/runtime/sandbox.ts` owns the QuickJS runtime, handles, bridge and job pump. `guest.js` installs the script API inside a private guest closure, removes temporary globals, and returns private settlement handles to the host. |
| Transports        | `src/drivers/cli.ts` builds vendor arguments and runs CLI attempts. `events.ts` normalizes their wire formats. `acp.ts` owns retained sessions and applies model, mode, then effort against refreshed capabilities.                                  |
| Process ownership | `src/drivers/process.ts` handles streams and bounded shutdown. `supervisor.cjs` owns the backend process group independently, including when the parent dies.                                                                                        |
| Presentation      | `src/progress.ts` owns live terminal rows. `output.ts` prepares report artifacts and formats summaries. `info.ts` collects and formats installation capabilities. `cli.ts` wires commands to these operations.                                       |

An agent failure usually becomes a null result with a persisted reason. Root
persistence failures and uncertain process ownership terminate the run. Keep
these cases distinct when moving error handling. Cancellation closes admission
before cleanup; an intentionally skipped agent can be replayed as null, while a
root-cancelled invocation remains unfinished and must run again on resume.

Confirmed subscription exhaustion uses that same root cancellation path. Drivers
emit `usage-limit` only for recognized refusals; the root persists backend/reset
details before aborting. Advisory quota state and generic 429s are insufficient.
See [harness evidence and recognition boundaries](USAGE-LIMITS.md).

Replay preparation holds prevent cached deliveries from racing script/child
setup. Release them before awaiting child execution. Do not replace delivery
scheduling with a broad `Promise.all` barrier: a pipeline item must be able to
advance independently. See the replay and run tests for observable-order cases.

`prepareReport()` can write oversized results to `result.json`; `formatReport()`
only renders the prepared summary. Keep disk writes visible at the call site.

## Source assets and examples

`guest.js` executes inside QuickJS and `supervisor.cjs` executes in a separate
Node process. Edit these source files directly. `scripts/build.ts` typechecks
and compiles the host, syntax-checks both programs, and copies their exact
source into `dist`. A package smoke check must exercise both the guest and a
fixture backend process; a successful TypeScript build alone cannot prove the
assets ship.

Workflow examples allow top-level `return`, which the ordinary module formatter
rejects. `scripts/format-examples.ts` temporarily wraps the body in an async
function, formats it with dprint, and unwraps it using Acorn. Multiline literal
contents and block-comment indentation are preserved. `mise run fix` and `mise
run check` include this step; examples remain standalone, readable scripts
rather than generated artifacts. The formatter regression tests compare executed
results and check idempotence.

Keep one blank line between class members and top-level declarations. Put the
public lifecycle before private supporting methods. Method bodies should read as
logical paragraphs: preparation, validation, execution and cleanup. Keep related
assignments together; do not separate every statement mechanically. Examples use
paragraphs for schema definitions, loop state, worker stages and final results.
Dprint preserves this layout, so source review must check it explicitly.

Comments earn their space by explaining ownership, ordering or policy: replay
holds, process-group anchors, append-only journals, atomic snapshots and direct
semaphore handoff are examples. Avoid comments that merely narrate assignments.

Lint requires braces, separate variable declarations and no nested ternaries.
These rules catch dense syntax; they do not establish good module boundaries.
Name stages and intermediate decisions when that makes a workflow easier to
follow, and prefer direct control flow over generic helper frameworks.

## Validation

Use `mise run check`, `mise run typecheck`, `mise run test`, and `mise run
build`. Tests use synthetic executables and recorded protocol fixtures, never
vendor subscriptions. `test/cli.test.ts` covers foreground/background/control
wiring; `test/process.test.ts` covers process ownership; `test/run.test.ts`
covers leaf lifecycle and root failure semantics; `test/sandbox.test.ts` covers
isolation; `test/examples.test.ts` executes the recipes with controlled agent
results. `test/acp.test.ts` separates generic session behavior from Qwen's
recorded model-dependent capability refresh.

---
name: workflow
description: Author and run deterministic JavaScript workflows that fan independent tasks out to coding agents, verify their outputs, and resume edited runs across supported harnesses.
---

# Workflow authoring

Use a workflow for repeated independent tasks, independent perspectives, or a
find-verify-fix loop whose control flow is clearer as code. Stay inline for a
single task or work whose next step needs continuous human judgment. The script
orchestrates; leaf agents perform model-driven work.

Run `workflow info` first. Select an available backend and a model using its
output and discovery notes. Claude lists aliases; full model IDs accepted by its
CLI also work. Check its effort levels, structured-output strategy, and
enforceable tool policies. Never copy model names from an example without
checking this installation. The CLI always disables approval prompts; this does
not grant additional user authorization. Prefer `toolPolicy: 'read-only'` for
review stages on backends that enforce it, and `isolation: 'worktree'` for
parallel edits. Use a container or VM for untrusted repositories. ACP backends
currently cannot enforce read-only policies and reject such a request.

## Model selection guidance

Based on which backends are available, load the relevant references to help you
select a model.

- [Claude](references/claude.md): Haiku, Sonnet, Opus, and Fable tiers, usually
  in Claude Code
- [GPT](references/gpt.md): Luna, Sol, and Astra tiers, usually in Codex

## Script contract

Write a `.js` file. No TypeScript, imports, filesystem access, process access,
network access, or timers. Standard JavaScript built-ins are available, except
`Math.random()`, `Date.now()`, `Date()`, and `new Date()` without arguments,
which throw. Explicit dates such as `new Date(0)` work. Scripts have memory,
stack, and instruction limits. Top-level `await` and `return` work.

The first statement must be this pure-literal header. No computed values,
spreads, interpolated strings, getters, or functions in metadata:

```js
export const meta = {
  name: "review-files",
  description: "Review files and independently verify each finding",
  whenToUse: "Several independent files need review",
  phases: [{ title: "Find" }, { title: "Verify", detail: "Refute each claim" }],
};
```

Use `workflow run ./review.js --args '{"files":["src/a.ts"]}'` or `--args-file
./input.json`. `workflow run -` reads a script from stdin. Set the run default
with `--backend <name>` or the config's top-level `backend`; use `--model <id>`
for a run model default. Per-agent and child overrides take precedence.
`defaults` holds other common agent options, never a second backend selection.
Add `.workflow/` to the repository's `.gitignore` so run artifacts and retained
worktrees do not enter commits. Paths in prompts should be absolute. A leaf sees
its prompt, the return-value and authority preamble, cwd, and its own harness's
normal instruction files. It sees no parent conversation, script state, args, or
sibling results unless the prompt includes them. Do not ask leaves to
re-delegate.

| Global                               | Behavior                                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent(prompt, opts?)`               | Returns final text, a validated object with `schema`, or `null` on failure/skip. Prompt must contain the entire task.                                                      |
| `pipeline(items, ...stages)`         | Each item advances immediately through its stages. Stage receives `(previous, originalItem, index)`. A throw makes that item's result null and skips its remaining stages. |
| `parallel(thunks)`                   | Runs zero-argument functions concurrently. Waits for all; a failed thunk becomes null.                                                                                     |
| `phase(title)`                       | Sets the phase for subsequent agents. Prefer per-agent `phase` in concurrent code to avoid races.                                                                          |
| `log(message)`                       | Emits a narrator line and stores it with the report.                                                                                                                       |
| `args`                               | JSON input, verbatim.                                                                                                                                                      |
| `budget`                             | Deferred ceiling: `total: null`, `spent(): 0`, `remaining(): Infinity`. Always guard on `total !== null`.                                                                  |
| `workflow(ref, args?, { backend }?)` | Runs a child inline with shared concurrency, agent cap and cancellation. Child gets its own args and optional default backend. No grandchildren.                           |

`ref` is a saved name in `.workflow/workflows/` or `.claude/workflows/`, a
script path relative to the parent file, or `{ scriptPath: './child.js' }`.

Literal references are loaded before agents start and remain fixed for that run.
For a child generated by an earlier agent, store its reference in a variable and
call `workflow(ref)` after awaiting the generator; computed references load at
first use. Children must have their own metadata. Do not use mutable global
phases as synchronization.

`agent` options:

| Option                       | Meaning                                                                                                                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`, `phase`             | Human-readable progress name/group.                                                                                                                                                                                                                                             |
| `backend`, `model`, `effort` | Per-call selection. Effort is low/medium/high/xhigh/max; supported levels come from `info`. Unsupported effort is reported.                                                                                                                                                     |
| `schema`                     | JSON Schema draft-07; root must be `type: 'object'` with `properties`, and required keys must exist in properties. No external refs. Output is validated without coercion. Invalid schemas throw at call time; exhausted correction attempts return null with a journal reason. |
| `isolation: 'worktree'`      | Fresh branch at repository HEAD. Clean unchanged worktrees are removed; changed or committed work is retained and recorded in the journal.                                                                                                                                      |
| `toolPolicy`                 | `'read-only'` or `{ allow: ['Read'], deny: ['Write'] }`, only where `info` advertises enforcement. Unsupported restrictions fail.                                                                                                                                               |
| `profile`                    | Named config bundle of backend/model/effort/system append/tool policy. Explicit call options override the bundle.                                                                                                                                                               |
| `minimal`                    | Suppress normal instruction discovery only on backends advertising support. Claude requires ANTHROPIC_API_KEY; helper-only authentication is not discovered.                                                                                                                    |
| `agentType`                  | Unsupported harness-specific registry; use `profile`.                                                                                                                                                                                                                           |

Agent prompt/options and final results must be finite JSON data. Do not put
functions, undefined values, cycles, or BigInts into options/results. Convert
Map/Set collections to arrays or plain objects; implicit empty-object encoding
is rejected. Explicit JSON `toJSON` serialization is honored. There are at most
1000 leaf invocations per root run, at most 4096 items per parallel or pipeline
call, and a shared concurrency limit shown by `info`. These are hard limits, not
truncation. All meaningful work must be awaited; returning early cancels
unfinished agents.

Worktrees contain committed tracked files. Configure opt-in local paths in
`.workflow/config.json` as `sharedPaths: [{ path: 'node_modules', mode:
'symlink' }]` or `mode: 'copy'`. A writable symlink remains shared with the
parent. Worktree paths and branches are result metadata in `workflow show`/the
journal; they do not change the text/object return shape of `agent()`. If a
later stage needs the branch or path, ask the isolated worker to include its cwd
and branch in its structured result, then pass those fields to that stage
explicitly.

Setup failures preserve the worktree and report its path/branch plus the actual
error.

## Pipeline first

Use `pipeline` when later work needs only that item's earlier result. Use a
barrier only for cross-item deduplication, an early exit when the entire set is
empty, or a prompt requiring all other findings. Parallel failure becomes null;
account for it explicitly instead of silently filtering every failure away.

```js
const finding = {
  type: 'object', properties: { issue: { type: 'string' } }, required: ['issue'],
};
return pipeline(args.files,
  file => agent(`Review ${file}. Return the most concrete bug.`, {
    schema: finding, phase: 'Find', label: file, toolPolicy: 'read-only',
  }),
  (result, file) => result === null ? null : agent(
    `Try to disprove this claim in ${file}: ${JSON.stringify(result)}`,
    { phase: 'Verify', toolPolicy: 'read-only' },
  ),
);
```

## Recipe library

Adapt these shapes to the user's scope. Every leaf needs concrete evidence and a
bounded assignment. Verification should try to refute a claim, not endorse it.

- **Adversarial verify:** for each finding, run three independent refuters with
  `{valid: boolean, reason: string}` schemas. Accept only when at least two
  valid results survive refutation. A failed refuter is not a positive vote.
  Return evidence and dissent, not just the vote count.
- **Perspective-diverse verify:** use correctness, security, performance, and
  reproduction lenses as separate prompts. Keep them blind to each other's
  conclusions until synthesis. Use per-agent phase labels.
- **Judge panel:** generate independent attempts, judge each against the same
  explicit rubric in parallel, then synthesize from the best supported attempt.
  Handle null attempts and tied scores explicitly. A winning score is evidence
  for selection, not proof of correctness.
- **Loop-until-dry:** maintain a Set of every finding ever seen, including
  rejected findings. Ask new finders to exclude that set. Stop after K
  consecutive rounds produce no new identities; reset the dry count on any
  novelty. Deduplication needs a barrier after a whole search round. Include a
  task-appropriate explicit round bound and log if it stops the loop.
- **Loop-until-budget:** guard `budget.total !== null` before comparing
  `budget.remaining()` with the cost of another round. Budget is currently
  disabled, so use a finite explicit round count and log that fallback. Never
  loop on Infinity alone.
- **Multi-modal sweep:** fan out strategy-specific searchers, for example
  history, call sites, invariants, and test gaps. Give each the same task
  context but no sibling conclusions. Merge and deduplicate after they finish,
  then pipeline findings through verification.
- **Completeness critic:** after synthesis, give a final critic the original
  requirements, evidence, and proposed result. Ask for missing requirements and
  unsupported claims. Return its findings alongside the synthesis or act on them
  within the authorized scope; do not treat an unexecuted plan as completion.
- **No silent caps:** whenever filtering, truncating, deduplicating, exhausting
  a retry/round bound, or dropping failed work, log the count and reason. Avoid
  `.filter(Boolean)` unless you also report what it removed.

Runnable versions of all eight recipes ship in the package’s `examples/`
directory; its README lists inputs and usage. The examples inherit run defaults
and request read-only review policies.

## Resume and inspect

Run in the foreground to see the live tree, or use `--background` for an
immediate run ID after preflight. `workflow wait <id>` shows current progress
and returns the compact result; Ctrl-C stops waiting without stopping the
background run. `workflow stop <id>` cancels the run and waits for owned worker
shutdown. `workflow skip <id> <agent-id>` skips one queued or running leaf. An
unresponsive control connection is not treated as proof that a run has stopped.

Stop the prior run before editing and resuming:

```sh
workflow run ./review.js --background --backend claude
workflow wait wf_012345abcdef
workflow skip wf_012345abcdef 4
workflow stop wf_012345abcdef
workflow run ./review.js --resume wf_012345abcdef
workflow show wf_012345abcdef
workflow show wf_012345abcdef --agent 4
workflow show wf_012345abcdef --agent 4 --transcript
workflow journal wf_012345abcdef
```

Resume replays the longest unchanged prefix of prompts and effective options.
The first changed/new/unfinished call and all later calls run live. Stopping a
run leaves its unfinished calls live on resume; an intentional per-agent skip
remains a cached null. Ordinary completed failures (including timeout or
exhausted corrections) also remain cached; change the affected prompt/options or
start a fresh run to retry them. Labels and phases are options too; changing
them invalidates the affected cached suffix. Execution-affecting defaults and
cwd also participate in matching. Omitted args reuse the saved input. Cached
transcripts remain readable through their originating run; keep that run's
artifacts when retaining a resumed run. Agents may already have made edits
before a crash; replay is not an exactly-once transaction for external side
effects. Inspect retained worktrees before re-running mutating work.

Read the journal before diagnosing an empty result. Distinguish errored,
skipped, empty text, and a valid empty structured object. Full backend streams
stay in per-agent transcripts. Completion prints counts, token usage, tool
calls, duration, logs, and the script result; missing backend usage is marked.
Results over 16 KiB spill to `result.json`; stdout includes the path and a 4 KiB
preview. `--json` emits NDJSON progress and a final report.

## Runtime overrides

`workflow info` reports configured limits and capabilities:

- `sandbox`: `memoryBytes` (default 64 MiB) and `instructions` (default
  100,000). Stack size is 512 KiB. No option grants scripts filesystem or
  network access.
- `transport`: `agentTimeoutMs` (no deadline by default; a number sets one per
  attempt), `discoveryTimeoutMs` (20,000 per discovery request), and
  `launchTimeoutMs` (120,000 for background readiness). Stop a stuck agent with
  `skip` or the run with `stop`.
- `schemaStrategy`: `auto` chooses native when its semantics match the caller's
  schema; `prompted` forces prompted output with validation. Automatic fallback
  from a native-capable backend is logged. `schemaRetries` bounds corrections;
  missing facts can still exhaust corrections and return null. ACP cannot
  enforce read-only restrictions during corrections, so that activity is warned
  and recorded.
- `sharedPaths`: the opt-in copy/symlink list described above controls what
  local state enters a worktree. Copy rejects symlink paths escaping the
  repository.

These settings live in `.workflow/config.json` or the global workflow config.
All storage and control failures fail the run; they must not be interpreted as a
successful empty result from a failed parallel stage.

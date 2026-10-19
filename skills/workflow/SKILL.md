---
name: workflow
description: Author and run deterministic JavaScript workflows that fan independent tasks out to coding agents, verify their outputs, and resume edited runs across supported harnesses.
---

# Workflow authoring

Use a workflow for repeated independent tasks, independent perspectives, or a
find-verify-fix loop whose control flow is clearer as code. Stay inline for a
single task or work whose next step needs continuous human judgment. The script
orchestrates; leaf agents perform model-driven work.

Run `workflow-cli info` first and select an available backend, model, effort
level and tool policy from its output. Claude lists aliases; full model IDs
accepted by its CLI also work. Never copy model names from an example without
checking this installation. The CLI always disables approval prompts; this does
not grant additional user authorization. Prefer `toolPolicy: 'read-only'` for
review stages and `isolation: 'worktree'` for parallel edits, and use a
container or VM for untrusted repositories. ACP backends (OpenCode, Kimi, Qwen)
reject read-only requests.

## Model selection guidance

Load the references for the available backends before choosing a model:

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

Use `workflow-cli run ./review.js --args '{"files":["src/a.ts"]}'` or
`--args-file ./input.json`; `workflow-cli run -` reads a script from stdin.
`--backend <name>` (or the config's top-level `backend`) and `--model <id>` set
run defaults; per-agent and child overrides take precedence. The config's
`defaults` holds other common agent options, never a backend. Add `.workflow/`
to the repository's `.gitignore` so run artifacts and retained worktrees do not
enter commits.

Paths in prompts should be absolute. A leaf sees its prompt, the return-value
and authority preamble, cwd, and its own harness's normal instruction files. It
sees no parent conversation, script state, args, or sibling results unless the
prompt includes them. Do not ask leaves to re-delegate.

| Global                               | Behavior                                                                                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent(prompt, opts?)`               | Returns final text, a validated object with `schema`, or `null` on failure/skip. Prompt must contain the entire task.                                                                                      |
| `pipeline(items, ...stages)`         | Each item advances immediately through its stages. Stage receives `(previous, originalItem, index)`. A throw makes that item's result null, skips its remaining stages and emits a warning with the error. |
| `parallel(thunks)`                   | Runs zero-argument functions concurrently. Waits for all; a failed thunk becomes null and emits a warning with the error.                                                                                  |
| `phase(title)`                       | Sets the phase for subsequent agents. Prefer per-agent `phase` in concurrent code to avoid races.                                                                                                          |
| `log(message)`                       | Emits a narrator line and stores it with the report.                                                                                                                                                       |
| `args`                               | JSON input, verbatim.                                                                                                                                                                                      |
| `budget`                             | Not enforced yet: `total: null`, `spent(): 0`, `remaining(): Infinity`. Always guard on `total !== null`.                                                                                                  |
| `workflow(ref, args?, { backend }?)` | Runs a child inline with shared concurrency, agent cap and cancellation. Child gets its own args and optional default backend. No grandchildren.                                                           |

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
| `minimal`                    | Suppress normal instruction discovery, only on backends advertising support. Claude requires `ANTHROPIC_API_KEY`.                                                                                                                                                               |
| `agentType`                  | Not supported; use `profile`.                                                                                                                                                                                                                                                   |

Agent prompt/options and final results must be finite JSON data. Do not put
functions, undefined values, cycles, or BigInts into options/results. Convert
Map/Set collections to arrays or plain objects; implicit empty-object encoding
is rejected. There are at most 1000 leaf invocations per root run, at most 4096
items per parallel or pipeline call, and a shared concurrency limit shown by
`info`. These are hard limits, not truncation. All meaningful work must be
awaited; returning early cancels unfinished agents.

Worktrees contain committed tracked files. Configure opt-in local paths in
`.workflow/config.json` as `sharedPaths: [{ path: 'node_modules', mode:
'symlink' }]` or `mode: 'copy'`; a writable symlink remains shared with the
parent. Worktree paths and branches appear in `workflow-cli show` and the
journal, not in the return value of `agent()`. If a later stage needs them, ask
the isolated worker to include its cwd and branch in its structured result.

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

- **Adversarial verify:** run three independent refuters per finding with
  `{valid: boolean, reason: string}` schemas and accept at two valid votes. A
  failed refuter is not a positive vote. Return evidence and dissent.
- **Perspective-diverse verify:** run correctness, security, performance, and
  reproduction lenses as separate prompts, blind to each other until synthesis.
- **Judge panel:** judge independent attempts against one explicit rubric in
  parallel, then synthesize from the best supported attempt. Handle null
  attempts and ties explicitly; a winning score is not proof of correctness.
- **Loop-until-dry:** keep a Set of every finding ever seen, including rejected
  ones, and ask new finders to exclude it. Stop after K consecutive rounds with
  no new identities, with an explicit round bound that is logged if it stops the
  loop.
- **Loop-until-budget:** budget is not enforced yet, so guard `budget.total !==
  null` and fall back to a finite, logged round count. Never loop on `Infinity`
  alone.
- **Multi-modal sweep:** fan out strategy-specific searchers (history, call
  sites, invariants, test gaps) with the same context and no sibling
  conclusions, deduplicate, then pipeline findings through verification.
- **Completeness critic:** give a final critic the requirements, evidence, and
  proposed result, and ask for missing requirements and unsupported claims. Do
  not treat an unexecuted plan as completion.
- **No silent caps:** log the count and reason whenever you filter, truncate,
  deduplicate, hit a round bound, or drop failed work. Avoid `.filter(Boolean)`
  unless you also report what it removed.

Runnable versions of these recipes ship in the package's `examples/` directory,
with a README listing their inputs.

## Resume and inspect

Run in the foreground to see the live tree, or use `--background` for an
immediate run ID. `workflow-cli wait <id>` shows progress and returns the
result; Ctrl-C stops waiting without stopping the run. `skip` ends one queued or
running leaf and `stop` cancels the run. Stop the prior run before editing and
resuming:

```sh
workflow-cli run ./review.js --background --backend claude
workflow-cli wait wf_012345abcdef
workflow-cli skip wf_012345abcdef 4
workflow-cli stop wf_012345abcdef
workflow-cli run ./review.js --resume wf_012345abcdef
workflow-cli show wf_012345abcdef
workflow-cli show wf_012345abcdef --agent 4 --transcript
workflow-cli journal wf_012345abcdef
```

Resume replays the longest unchanged prefix of prompts and effective options
(including labels, phases, defaults and cwd); the first changed, new or
unfinished call and everything after it run live. Calls unfinished when a run
was stopped run live on resume, while a skipped agent stays a cached null. A
confirmed Claude or Codex usage limit stops the whole run and reports the reset
time; resume once access returns. Other completed failures, including timeouts
and exhausted corrections, stay cached; change the affected prompt or options,
or start a fresh run, to retry them. Omitted args reuse the saved input. Cached
transcripts are read from their originating run, so keep its artifacts. Replay
does not undo edits an interrupted agent already made; inspect retained
worktrees before re-running mutating work.

Read the journal before diagnosing an empty result: distinguish errored,
skipped, empty text, and a valid empty structured object. Full backend streams
stay in per-agent transcripts. Results over 16 KiB spill to `result.json`, and
stdout shows the path and a 4 KiB preview. `--json` emits NDJSON progress and a
final report.

## Runtime overrides

`workflow-cli info` reports configured limits and capabilities:

- `sandbox`: `memoryBytes` (default 64 MiB) and `interruptChecks` (default
  100,000), a per-run cap on QuickJS's periodic interrupt polls rather than an
  instruction count. Stack size is 512 KiB.
- `transport`: `agentTimeoutMs` (per attempt; no deadline by default, so use
  `skip` for a stuck agent), `discoveryTimeoutMs` (default 20,000), and
  `launchTimeoutMs` (default 120,000, for background readiness).
- `schemaStrategy`: `auto` chooses native output when its semantics match the
  caller's schema; `prompted` forces prompted output with validation.
  `schemaRetries` (default 2) bounds correction attempts.
- `sharedPaths`: the opt-in copy/symlink list described above.

These settings live in `.workflow/config.json` or the global workflow config.

# Claude Fable 5.1 initial review

Model: claude-fable-5-1; Claude CLI 2.1.261; 2026-09-05. This review evaluated
an evolving initial implementation and is not completion approval.

Review complete. I read the vision, backend notes, decisions, status, every
source file, all four test files, the skill, README, and the example. Verdict
first, then findings.

**Verdict.** The full vision is not complete, and the evidence does not support
calling the code, UX, or guidance high quality yet. The runtime core is solid in
places, but I found one replay correctness bug that breaks the "same script plus
same args is a full cache hit" guarantee, a silent structured-output fallback
that violates the fail-loud principle, several `info` claims with no observation
behind them, and a hard-coded undocumented timeout. Nothing in `src/drivers`,
`src/cli.ts`, or `src/output.ts` has a test, and the fixtures that `AGENTS.md`,
the driver header comment, and the README all describe do not exist. Several
deviations from the vision are not logged in `DECISIONS.md`.

## Correctness

- **Replay diverges falsely when more than 1024 guest jobs separate two agent
  calls.** `src/runtime/replay.ts:131-137` assumes the guest drains all
  microtasks before the replay pump runs, but `src/runtime/sandbox.ts:55`
  executes jobs in batches of 1024 and reschedules with `setImmediate`, which
  lands after the replay pump's own `setImmediate` at `replay.ts:114`.
  Counterexample: an unchanged pipeline of 1500 items whose first stage does
  `await Promise.resolve()` before calling `agent()`; on resume the pump sees a
  `start` record instead of a `finish`, declares "Edited control flow no longer
  reaches the next cached invocation", and reruns every call after roughly the
  first thousand live.
- **Codex silently downgrades native structured output to prompted.**
  `src/runtime/run.ts:368-371` picks prompted when the schema lacks
  `additionalProperties: false` or full `required` lists, but emits no warning
  and `info` still reports `structured native` for codex at
  `src/drivers/cli.ts:121`. Counterexample: `agent(p, {backend: 'codex', schema:
  {type:'object', properties:{x:{type:'string'}}}})` runs prompted with no log
  line, contradicting VISION.md line 339.
- **Structured-output retries relaunch the entire agent in a fresh session.**
  `run.ts:392-457` builds a new driver request per attempt, so the model has no
  memory of its previous turn and the original task prompt is resent with
  feedback appended. A fixer agent that edits files and then returns prose gets
  rerun and edits again, despite the "do not repeat edits" line at `run.ts:455`.
  The strict whole-text fence regex at `src/runtime/schema.ts:81` makes this
  common: opencode returning "Here is the result:" before a fence triggers a
  full rerun.
- **Every agent is killed after 15 minutes with no configuration or
  documentation.** `src/drivers/process.ts:53-57` defaults `timeoutMs` to 900000
  and `src/drivers/acp.ts:329` hard-codes the same for `session/prompt`. A long
  refactor on a slow model is journaled as errored with "Backend timed out".
  Neither `info`, the skill, nor the README mentions it.
- **Config `defaults.backend` silently overrides `--backend` and child
  overrides.** `run.ts:128-132` merges defaults into options, and `run.ts:247`
  then prefers `options.backend` over `scope.backend`. Config
  `{"backend":"codex","defaults":{"backend":"claude"}}` makes `--backend codex`
  a no-op.
- **`log()` rejects non-strings and kills the workflow.** `sandbox.ts:88` throws
  for `log(findings.length)`. VISION.md line 54 types the argument as a message
  with no such restriction, and this is a portability trap for reference
  scripts.
- **Progress elapsed time keeps counting after an agent finishes.**
  `src/output.ts:165` computes elapsed from `row.started` on every render and
  ignores the `elapsedMs` carried on the finish event. A 5-second agent reads
  60s a minute later.
- **A second Ctrl-C orphans every backend process.** `src/cli.ts:163-164`
  registers `once` handlers, so the next SIGINT kills the CLI with default
  behavior while children spawned `detached: true` at `process.ts:46-51` survive
  in their own groups. Not documented.

## Capability reporting and drivers

- **Claude per-model effort lists are invented.** `cli.ts:13-22` assigns
  different effort sets to sonnet and haiku, but BACKENDS.md line 27 only
  records that `--effort low..max` exists. The header comment at `cli.ts:9`
  claims verification that is not in the document.
- **Effort is never validated against what `info` reports.** `run.ts:398-403`
  passes any enum value through regardless of `detection.models[].efforts`.
  `info` also lists `ultra` for codex models, but `src/types.ts:29` cannot
  express it, so `effort: 'ultra'` fails with a zod enum error while `info`
  advertised it.
- **Codex model discovery marks no default and lists hidden models.**
  `cli.ts:159` reads `is_default`, a field BACKENDS.md line 81 does not record,
  and nothing filters `visibility: hide`. Cursor efforts stay empty at
  `cli.ts:173` even though BACKENDS.md line 135 asks `info` to list the suffix
  forms.
- **ACP model and effort selection is unobserved.** `acp.ts:284-316` calls
  `session/set_config_option` and `session/set_model`, neither of which appears
  anywhere in BACKENDS.md. Since opencode names no model in its stream per
  BACKENDS.md line 96, a server that accepts and ignores the call would apply
  the wrong model with no signal. The `thought_level` category match at
  `acp.ts:204` and the `usage_update` field names at `acp.ts:266-275` are
  likewise unprobed guesses.
- **Kimi permission behavior over ACP is untested and can hang.** BACKENDS.md
  line 169 says no backend sent `session/request_permission` during probing. If
  kimi consults its config file instead of asking the client, the only backstop
  is the 15-minute timeout, which is the exact failure VISION.md line 337 names
  as the worst one.
- **`info` creates real vendor sessions.** `acp.ts:191-198` spawns each ACP
  server and calls `session/new` just to list models, when BACKENDS.md lines 98
  and 118 document side-effect-free listings for opencode and kimi. README line
  24 admits the side effect rather than avoiding it.
- **Choosing ACP drops documented CLI capabilities without a full decision
  entry.** Opencode loses `--variant` effort, and qwen loses native schema,
  `--append-system-prompt`, read-only mode, and its hard limits. DECISIONS.md
  line 57 mentions only the qwen schema loss.
- **Claude read-only combined with a schema is unverified.** `cli.ts:49-50`
  sends `--tools Read,Grep,Glob`; whether the forced StructuredOutput tool
  survives that allowlist is not recorded anywhere, yet the skill's headline
  example at `skills/workflow/SKILL.md:101-109` depends on it.
- **The `info` text hard-codes `worktree yes`** at `cli.ts:69` instead of
  reading the detection, and omits the usage capability and the timeout.

## UX, guidance, tests, and decisions log

- **Progress rendering is unthrottled and floods `--json`.** `output.ts:137`
  re-renders the whole tree on every event, and each ACP text chunk becomes an
  activity event via `run.ts:413`, so ten streaming agents mean hundreds of
  full-screen rewrites per second. In `--json` mode every chunk goes to stdout,
  which is the opposite of "the caller is a model".
- **`show` and `journal` ignore `--cwd`.** `cli.ts:204` and `cli.ts:235` default
  to `.workflow/runs` under the shell's directory while `run` writes under the
  agent cwd at `cli.ts:112`.
- **Launch-time backend errors dump the whole detection object.** `run.ts:156`
  stringifies models and notes into one line. With opencode that is 87 model
  IDs.
- **The notice prints on every run** at `cli.ts:165`. VISION.md line 186 says
  first run.
- **The skill never explains run-level backend selection.** VISION.md line 103
  says reference scripts need "at most the addition of a backend selection", but
  the skill mentions neither `--backend` nor the config key.
- **The skill does not warn that `label` and `phase` are part of the replay
  key.** `run.ts:248-257` hashes all effective options, so renaming a label
  invalidates every downstream cached call. The skill also tells authors to stop
  a run before resuming but there is no stop command, only Ctrl-C.
- **Scripts cannot see worktree paths.** VISION.md line 240 says a later stage
  can merge, but the branch and path only reach the journal at `run.ts:464`. The
  skill should tell authors to have the agent report its own cwd, and does not.
- **Sandbox limits are undocumented in magnitude.** `sandbox.ts:31-37` sets 64
  MiB and a cumulative interrupt budget with no reset. A thousand agents
  returning 100 KB each exhaust guest memory and fail the run with a QuickJS
  error.
- **Nothing tells users to ignore `.workflow/`.** Runs and worktrees live inside
  the repo at `src/runtime/worktree.ts:22`, and only the test at
  `test/worktree.test.ts:16` adds the ignore rule.
- **Tests do not cover the surface under review.** No test exercises
  `cliArguments`, `CliEventParser`, `AcpConnection`, `modelOptions`, `Progress`,
  `printReport`, `loadConfig`, or any command in `cli.ts`. `dprint.jsonc:15`
  excludes a `test/fixtures` directory that does not exist. `run.test.ts`
  substitutes a fake driver, so worktree-plus-driver and child replay paths are
  untested.
- **Deviations are missing from `DECISIONS.md`.** Unlogged: the per-agent
  timeout, worktree location and branch naming versus VISION.md line 299, the
  extra `meta` global at `sandbox.ts:153`, label-in-key, notice-every-run, and
  the QuickJS limits.

What is done well: the QuickJS bridge passes only JSON and blocks constructor
escape, replay records delivery order so reversed pipelines replay faithfully in
the common case, tool policies fail closed, and worktree cleanup preserves
committed work. Those parts match the invariants in `CLAUDE.md`. The gaps above
are what stands between this and a complete, high-quality project.

# Fable readability and maintainability review

Date: 2026-09-05. Reviewer: Claude Fable 5.1, independent adversarial reviewer.
Scope: the uncommitted tree against `109c8d2` (staged, unstaged, and untracked
files), read in full. Prior completion approvals were not treated as evidence.
No implementation files were edited and no vendor binaries were invoked.

## Verdicts

- **Readability: APPROVE.**
- **Maintainability: APPROVE**, with the non-blocking follow-ups listed below.
  Two of them are small guardrail gaps that I would fix before the next feature
  lands.

## What I verified

| Check                                                                                                                             | Result                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `tsc --noEmit`                                                                                                                    | clean                                                                        |
| `vp check --no-fmt` (with the new curly, no-nested-ternary, one-var rules)                                                        | clean, 54 files                                                              |
| `dprint check` and `format-examples.ts --check`                                                                                   | clean                                                                        |
| Offline suite (`pnpm test`)                                                                                                       | 84 passed, 0 failed, on the tree as of my last run                           |
| `pnpm run build`                                                                                                                  | copies `guest.js` and `supervisor.cjs` into `dist`, both pass `node --check` |
| Built CLI smoke run against a fixture-less script                                                                                 | completes and prints a report                                                |
| Formatter probe (regex with spaces, nested template literal, string continuation, empty body, trailing comment, function in body) | all idempotent, literal data preserved                                       |

I also walked the old inline `liveAgent` body against `AgentExecution` line by
line for behavioral drift: capability checks, worktree creation order, the
native-versus-prompted decision and its warnings, preamble assembly, correction
tool policy, session retention, usage and cost accumulation, empty-result
handling, validation feedback, the skipped/errored/cancelled status rules, and
the cleanup ladder. I found no divergence. The `this.attempt` field replaces a
loop variable captured by the first turn's ACP callback, and the comment at
`src/runtime/agent.ts:61` says why. `executeChild` preserves the old
hold-then-release ordering around child preflight and the release is idempotent,
so the double release in `finally` is safe.

## Assessment of the major seams

**AgentExecution / WorkflowRun split** is the right cut. A maintainer can now
read `run()` in `src/runtime/agent.ts:80` top to bottom: acquire, detect, check,
prepare worktree, emit started, run turns, record failure, cleanup, release. The
root keeps admission, replay, journaling, and fatal persistence. The
`AgentServices` interface makes the coupling explicit rather than reaching into
the root.

**guest.js and supervisor.cjs as real files** is a clear win over embedded
strings. Both are commented at the top with their runtime, `scripts/build.ts`
syntax-checks and copies them, and `hk.pkl` now lints `.cjs`. The sandbox test
confirms the bootstrap closure names are unreachable from user code.

**Replay renames** (`traceIndex`, `nextInvocationId`, `currentInvocationId`, and
the comment that pending keys are previous-run IDs) resolve the one place where
the old code was genuinely confusing.

**ACP `configureSession`** and the CLI `codexEvent` / `claudeOrCursorEvent`
split make the per-vendor branches readable without changing wire behavior. The
"model, then mode, then effort" ordering comment is the important invariant and
it is stated.

**prepareReport / formatReport** makes the `result.json` write visible at the
call site, which is what the doc promises.

**Examples** now read as ordinary JavaScript. `judge-panel.js` with
`proposeAttempt`, `judgeAttempt`, `scoreCandidate` is a real improvement over
the inline pipeline lambdas. The AST-unwrapping formatter preserves cooked and
raw literal contents, and the regression test proves execution equivalence and
idempotence.

**Split ACP tests** with `WORKFLOW_FIXTURE_ACP_SESSION` replace a
string-substitution hack in the fixture with an explicit path, and the Qwen test
now runs the fake under the `qwen` binary name and `--acp` argv, which is more
faithful than before.

## Findings (none blocking)

1. **Formatter dedents block-comment interiors that code-style formatting would
   leave alone.** `scripts/format-examples.ts:56-72` protects string and
   template literal ranges but not comment ranges. I confirmed dprint leaves
   block-comment interior lines untouched in both wrapped and unwrapped form, so
   the unwrapper's blanket two-space strip is the only thing that shifts them. A
   block comment with an indented example or diagram is altered on first format.
   Fix: collect `Block` comment ranges via acorn's `onComment` and treat them
   like literals. Add one case to `test/format-examples.test.ts`.

2. **Profile `systemAppend` derivation is duplicated in `WorkflowRun`.**
   `src/runtime/run.ts:468` (inside the replay key) and `src/runtime/run.ts:548`
   (passed to `AgentExecution`) compute the same expression. If someone changes
   one, cache keys and prompts silently disagree. Extract a
   `profileSystemAppend(options)` method and use it in both places.

3. **The JSON round-trip in `agent()` is opaque.** `src/runtime/run.ts:493-497`
   does `jsonValue.parse(JSON.parse(JSON.stringify(await
   this.liveAgent(...))))`. This strips `undefined` fields so the record is a
   valid `Json` for the replay journal, but nothing says so. A one-line comment
   or a named `toJournalValue(record)` helper would do.

4. **`AgentExecution` writes a placeholder `key: ""`** at
   `src/runtime/agent.ts:73`, relying on the root to overwrite `key`, `cached`,
   `phase`, and `options` after replay. That is fine, but it is a hidden
   contract. A comment on the field, or making the root-owned fields explicit in
   the return shape, would prevent someone from "fixing" the empty key inside
   the leaf.

5. **Runs-directory resolution is still written out four times in
   `src/cli.ts`.** `storageRoot` exists at `src/cli.ts:271` but `run` (line 83),
   `show` (line 203), and `journal` (line 253) inline the same expression above
   its definition. Move `storageRoot` and `InspectOptions` to the top and use
   them everywhere. Likewise `join(run.store.directory, "script.js")` appears
   three times in the `__worker` command.

6. **`cleanupUncertain` is the most important boolean in process ownership and
   it has no explanation.** `src/drivers/process.ts:154-156` computes it as
   `!!drainError || (!backendExit && !spawnError && !this.forcedGroupKill)`.
   Each clause corresponds to a distinct real-world scenario covered in
   `test/process.test.ts`. A short comment naming those scenarios would save a
   future maintainer a test archaeology session. This file received only brace
   changes in this cleanup.

7. **Two remaining deep callback nests.** `src/runtime/sandbox.ts:204-238`
   (result delivery with four nested try/finally levels) and
   `src/background.ts:139-172` (async IIFE inside a message handler inside a
   promise executor). Both are followable because the inner closures have names,
   but the sandbox one would read better as a `deliverResult(outcome)` function.
   Not required.

8. **`prepareResultDisplay` is exported but used only by `prepareReport`**
   (`src/output.ts:20`). Making it module-private keeps the "one function writes
   to disk" story simpler.

9. **Guardrail gap: no test asserts that `__argsJson` and `__metaJson` are
   deleted after bootstrap.** The sandbox test at `test/sandbox.test.ts:191`
   checks the closure names but not the two new temporary globals that the guest
   comment promises to remove. The leak would be harmless (the same data is
   exposed as `args` and `meta`), but the test should match the comment. One
   extra entry in the existing `typeof` array covers it.

10. **`docs/STATUS.md:25` still says 81 tests passed**; the suite is now 84. The
    main agent is editing that file, so this is only a reminder.

## What would have made me withhold

I looked specifically for the failure modes the user named: overcompressed
expressions, hidden state coupling, misleading names, broad responsibilities,
opaque nesting, duplication, unreadable examples, and missing guardrails. The
nested ternaries and one-line `if` bodies are gone and lint now prevents their
return. The one genuinely misleading naming (replay `id` versus `index` versus
`sequence`) is fixed. The one large mixed-responsibility method (`liveAgent`) is
now a class with named phases. The examples are readable and mechanically kept
that way. The remaining items above are polish and small guardrails, not
structural problems, so neither verdict is withheld.

No files edited; no vendor calls made.

Follow-up verification complete. The response below is written to be appended
verbatim to the review record.

---

## Follow-up verification (Claude Fable 5.1, 2026-09-05)

Scope: only the changes resolving findings 1 through 10 of the review above. No
files were edited, no subagents were used, and no vendor binaries were invoked.

### Verdicts

- **Readability: APPROVE, reaffirmed.**
- **Maintainability: APPROVE, reaffirmed.** The two guardrail gaps I asked to
  have closed before the next feature (findings 1 and 9) are closed and tested.

### Per-finding disposition

| #  | Finding                                       | Resolution                                                                                                                                                                                                                                                                                                                                                     | Behavior preserved?                                                                                                                                                                                          |
| -- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1  | Formatter dedents block comments              | `onComment` collects `Block` ranges into `preservedRanges` alongside string and template ranges. The opening line, which dprint indents, is still dedented; interior lines and the closing line are left alone.                                                                                                                                                | Yes. The new test formats a top-level diagram comment, asserts the exact comment text survives, asserts execution equivalence, and asserts idempotence. `format-examples.ts --check` passes on all examples. |
| 2  | Duplicated `systemAppend` derivation          | `profileSystemAppend(options)` is one private method used in the replay key and in the `AgentExecution` input. Both call sites receive an object with the same `profile` field, since `effective` is a spread of `options` plus `backend`.                                                                                                                     | Yes.                                                                                                                                                                                                         |
| 3  | Opaque JSON round-trip                        | Module-level `toJournalValue(record)` with a one-line comment stating that optional fields hold `undefined` and are omitted at the JSON boundary.                                                                                                                                                                                                              | Yes. Same three-call expression.                                                                                                                                                                             |
| 4  | Placeholder `key: ""`                         | Comment on the field names the root as the owner of replay identity and current-call metadata.                                                                                                                                                                                                                                                                 | Yes.                                                                                                                                                                                                         |
| 5  | Repeated path derivation in `cli.ts`          | `InspectOptions`, `storageRoot`, and `launchIdentity` sit at the top of the file. `run`, `show`, `journal`, `stop`, `skip`, and `wait` all use `storageRoot`. The three `__worker` notifications use `launchIdentity`.                                                                                                                                         | Yes. `storageRoot` is byte-identical to the previous inline expression, and `report.directory` is assigned from `store.directory` at construction.                                                           |
| 6  | Undocumented `cleanupUncertain`               | A three-line comment names the drain-timeout case and the unexplained-supervisor-exit case, with the three exclusions listed.                                                                                                                                                                                                                                  | Yes. Expression unchanged.                                                                                                                                                                                   |
| 7  | Deep callback nests                           | `deliverResult(outcome)` in the sandbox and `finishLaunch(reply)` in background are named functions. I diffed each against the original inline closure. The `closed` guard, encode-and-dispose ordering, `catch` to `fail`, the `finally` dispose, the log-move fallback, disconnect and unref ordering, and the failed-versus-ready branch are all unchanged. | Yes.                                                                                                                                                                                                         |
| 8  | Exported `prepareResultDisplay`               | Now module-private.                                                                                                                                                                                                                                                                                                                                            | Yes.                                                                                                                                                                                                         |
| 9  | Missing `__argsJson` / `__metaJson` assertion | Both are in the `privateNames` array with `__dispatch`, `__validate`, `__notify`, and the lexical bootstrap names. The `typeof` probe asserts every entry is `undefined`.                                                                                                                                                                                      | Guardrail now matches the guest comment.                                                                                                                                                                     |
| 10 | STATUS test count                             | The readability cleanup section reports 84/84.                                                                                                                                                                                                                                                                                                                 | Documentation only.                                                                                                                                                                                          |

### Checks I ran on the follow-up tree

| Check                                                                                 | Result              |
| ------------------------------------------------------------------------------------- | ------------------- |
| `tsc --noEmit`                                                                        | clean               |
| `vp check --no-fmt`                                                                   | clean, 54 files     |
| `dprint check`                                                                        | clean               |
| `format-examples.ts --check`                                                          | clean               |
| Targeted suite: format-examples, sandbox, process, cli, run, output, replay, examples | 66 passed, 0 failed |

I did not rerun the acp, config, events, and worktree tests, since none of the
follow-up changes touch those files. The main agent's full run is the authority
for the whole suite.

### Unresolved concrete issues

None blocking. Two cosmetic points a maintainer may want to pick up later:

- `finishLaunch` in `src/background.ts:123` accepts the full `LaunchReply`
  union, including `"starting"`, even though the caller filters that case out
  first. Narrowing the parameter type would make the contract self-describing.
  No behavior change.
- `docs/STATUS.md:25` still reads "81 passed" under a heading dated the same day
  as the cleanup section that reads "84/84". The two blocks are distinguishable
  by section order, but a short qualifier such as "pre-cleanup suite" on the
  first would remove the need to infer it.

Neither affects the verdicts. The follow-ups resolve the findings as specified,
keep root-versus-leaf ownership and the cleanup ordering explicit, and I found
no behavioral drift.

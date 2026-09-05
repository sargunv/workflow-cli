# Fable whole-project completion review

Model: claude-fable-5-1; 2026-09-05. Independent final review.

# Whole-project completion review (Claude Fable 5.1, 2026-09-05)

## Verdict

**Approval is withheld on one blocking finding.** Resume after `workflow stop`
replays every agent that was running or queued at the stop as a cached `null`,
so the documented stop, edit, resume loop does not work for fan-outs. Everything
else I checked holds up. Once that finding is fixed with a regression test, I
would affirm all four required conclusions. My conditional position on each is
at the end.

Verification performed, all offline: read VISION.md, DECISIONS.md, REFERENCE.md,
BACKENDS.md, BACKEND-VERIFICATION.md, STATUS.md, both prior reviews, every
source file, every test, the skill, all eight recipes and their README, the
recorded fixtures, and the live-run artifacts under `.workflow/`. Ran the suite
(78 passed), typecheck, lint, and build. Exercised the built CLI against the
offline fake backend for `info`, `run`, `run --json`, `run -`, `show`, `show
--agent`, `--transcript`, `journal`, `--resume`, result spill, and the error
paths. Wrote two throwaway probes against the runtime and driver argv builder.
No vendor binary was invoked.

## Blocking finding

**1. Cancelled agents are frozen into the replay cache.**
`src/runtime/run.ts:729` marks any aborted leaf as `skipped`, whether the abort
came from a per-agent `skip` or from the root controller during `stop`, Ctrl-C,
or a launcher timeout. `src/runtime/replay.ts:113` then writes a `finish` event
for that record, and `src/runtime/replay.ts:73` treats every `finish` as a
terminal. On an unchanged resume the call matches, so the cancelled agent
returns `null` from cache instead of running.

Reproduced with a driver stub: script runs `agent('a')` then a parallel of three
agents with concurrency 2. Cancel after `a` completes. Resume unchanged.

```
first:  cancelled  [1 done] [2 skipped] [3 skipped] [4 skipped]
second: completed  result [null,null,null]
second agents: all four cached; live calls on resume: []
```

VISION.md names "stop the run, edit the script file, resume" as the intended
iteration loop, and the skill tells authors to stop before resuming. With this
behavior, stopping a fan-out of fifty with concurrency ten leaves forty calls
permanently `null` unless the author edits each one. A hard kill actually
resumes better than a clean stop, because a killed run has no `finish` events.
Per-agent `skip` caching as `null` is reference behavior and should stay.

Fix: distinguish run cancellation from per-agent skip in `liveAgent` (the root
signal versus the per-agent controller). Still journal the record so `show`
explains it, but do not let it become a replay terminal. Either skip the
`finish` write for run-cancelled records or add a status such as `cancelled` and
have `Replay` exclude those from `terminals`. Resume will then diverge to live
at the first cancelled call, which is correct since everything after a stop is
incomplete. Add a regression in `test/run.test.ts`: stop mid-parallel, resume
unchanged, assert completed agents are cached, cancelled ones run live, and the
result is non-null. If you instead decide the reference freezes these, that must
go in DECISIONS.md and the skill, but I would not approve that choice as meeting
the VISION resume requirement.

## Non-blocking findings

- **Script errors render as a JSON blob.** `src/runtime/sandbox.ts:202`
  stringifies the dumped error object, so `throw Error('Pass --args ...')` in a
  recipe prints `Error: {"name":"Error","message":"...","stack":"..."}` in both
  the human report and the `--json` `error` field. This is the most common
  authoring mistake and it costs the calling model context. Format as `name:
  message` plus the location line.
- **EPIPE crashes with a stack trace.** `workflow skill --print | head -3` and
  `workflow run ... | head` exit with an unhandled `write EPIPE` from
  `src/output.ts` and `src/cli.ts`. Add a stdout error handler that exits
  quietly on EPIPE.
- **Errored results are also cached on resume.** A timeout or exhausted
  correction is replayed as `null` on an unchanged resume. This is consistent
  with REFERENCE.md ("do not assume cached results are non-empty"), so it is not
  a defect, but neither the skill nor DECISIONS.md says it. One sentence in the
  resume section, and a DECISIONS entry, would prevent authors assuming failures
  rerun.
- **Empty allow-list correction turn on Claude** emits `--tools ""` with
  `--json-schema`, as DECISIONS.md acknowledges. Whether StructuredOutput
  survives an empty tool list is unprobed. Acceptable as a recorded limitation.
- **Doc drift to clear before release.** README still says the implementation is
  under construction and has not passed review. The cited cache-hit run
  `wf_3577c4bf49bb` predates the current build (no `transcripts/` directory),
  though the current cache-hit link behavior is covered by `test/cli.test.ts`.
  One lint warning remains in `test/output.test.ts:136`.

## Recheck of prior review findings against current code

All blocking items from `docs/reviews/fable-drivers.md` and
`docs/reviews/astra-completion.md` are fixed in the code I read, with
regressions:

- Cursor last complete assistant message after tool activity
  (`src/drivers/events.ts:92-119`), fixture asserts `parseStructured` yields
  `{code: 731}`, and `cursor-models.txt` is recorded.
- Claude `minimal` gated on `ANTHROPIC_API_KEY` with an explanatory note,
  tested.
- Literal profile backends preflight, and one in-flight discovery per backend is
  shared across concurrent computed selections (`src/runtime/run.ts:187-198`),
  tested.
- Qwen falls back to `models.availableModels` and attaches effort to the current
  model, tested against the recorded surface.
- Cost is absent unless reported; Claude input includes cache tokens; unknown
  usage stays unknown.
- Schema traversal visits only schema-bearing keywords, and contradiction checks
  apply only to type-relevant bounds; const, enum, default, optional and
  alternative branches no longer trip false refusals.
- Cached replay write failures reject every waiter and poison later calls; the
  correction and validation transcript writes go through `persist` and fail the
  run rather than surfacing as a successful parallel `null`.
- Human output sanitizes control bytes in strings, paths, and multiline results.
- `agentType` is rejected in profile configuration and in call options.
- `--model` exists, is recorded as the run default, and is documented in the
  README, skill, and examples README.
- `session/set_model` is verified, Cursor tool labels select the `*ToolCall`
  key, and the fixture README records provenance.

## What passed under adversarial inspection

The sandbox exposes only JSON across the bridge, bans the clock and randomness
routes including descriptor and constructor escapes, and enforces memory, stack,
and instruction limits. Pipeline has no barrier and preserves item and index.
Replay records deliveries separately from invocations and reproduces reversed
completion order, with edited-branch and microtask-drain regressions. Children
are one level deep, preflighted when literal, archived with hashes, and
recoverable when generated. Drivers fail closed on unsupported tool policies and
minimal mode, warn on dropped effort, validate native output against the
caller's schema, never resend the task on correction, and retain ACP sessions.
Worktrees lock a fresh branch, validate shared paths, and preserve changed,
committed, ignored, or partially set up trees. Process ownership survives owner
death and TERM-ignoring descendants, and uncertain cleanup fails the run.
Control is token-authenticated on loopback. The progress tree, compact report,
spill, NDJSON, and drill-in commands behave as VISION describes. The skill
covers every required topic and all eight recipes execute in the real sandbox
with the documented failure handling.

## Required conclusions

1. **Full VISION scope completed:** not yet. The resume iteration loop is broken
   for stopped runs (finding 1). Every other VISION requirement is implemented
   or explicitly deferred with rationale in DECISIONS.md.
2. **Code high quality:** yes, conditional on finding 1. The runtime is compact,
   invariants are tested with fault injection, and the drivers are honest about
   capabilities.
3. **UX high quality:** yes with the two small fixes above (error rendering,
   EPIPE). The terminal, JSON, and inspection surfaces are well designed for a
   model caller.
4. **Authoring and design guidelines correctly followed:** yes. The skill,
   recipes, README, and DECISIONS.md match the code, with the one documentation
   gap on cached failures noted above.

Fix finding 1 with its regression, and I will affirm all four without
qualification.

## Final follow-up

Model verified from CLI response metadata: claude-fable-5-1.

**Verdict: the fixes hold up under independent recheck. I affirm all four
criteria.** This supersedes the conditional verdict in my earlier review.

**What I verified, all offline, no repo edits:**

- Read the changed code: the replay cache gate, the runtime's leaf and finish
  paths, the guest error formatter in the sandbox, the stdout error handler in
  the CLI, and the new regression tests in the runtime and CLI suites.
- Ran the suite, typecheck, lint, build, and a pack dry run. Results below.
- Wrote throwaway probes under /tmp against the runtime with a driver stub, plus
  built-CLI probes with the fake backend.

| Check            | Result                       |
| ---------------- | ---------------------------- |
| Offline tests    | 81 passed, 0 failed          |
| Typecheck        | clean                        |
| Lint (`vp lint`) | clean, prior warning gone    |
| Build            | clean                        |
| `mise run check` | fails on one file, see below |

**The original blocker is fixed.** My probe reran the exact scenario from the
earlier review: seed completes, stop with two running and one queued at
concurrency two, resume unchanged. The first run is cancelled with the seed done
and three skipped, each journaled with a "Run cancelled" reason. The replay
trace has start events but no finish events for the three. The resume caches the
seed only, runs all three live, and returns the full non-null array. Three
further probes also behaved correctly: stopping during the seed reruns
everything; a per-agent skip and an ordinary errored result both stay cached on
resume, matching the new DECISIONS and skill text; an agent left unawaited at
script end is runtime-cancelled and not cached. Infrastructure failures cancel
the run through the same path, so uncertain-cleanup records are never cached
either.

**The UX notes are fixed.** A script throw now renders as name, message, and
workflow location in both the human report and the JSON error field. A closed
stdout pipe on the built CLI is silent, exits zero, records the run as cancelled
with a "Run cancelled: Output pipe closed" agent reason, and the control
endpoint is closed. The CLI regression covers the same path.

**Remaining items, none blocking the four criteria:**

- `mise run check` is currently red because docs/reviews/astra-completion.md is
  not dprint-formatted. That is the in-flight final check you mentioned. It must
  be green before release, but it is a review document, not code.
- Cosmetic nit: the report already prefixes errors with "Error:", so a plain
  throw reads as "Error: Error: Pass --args". A failed run also prints a
  trailing "null" result line. Both are minor and pre-date this round in spirit.

**Final affirmative agreement:**

1. Full VISION scope completed: yes.
2. Code high quality: yes.
3. UX high quality: yes.
4. Authoring and design guidelines correctly followed: yes.

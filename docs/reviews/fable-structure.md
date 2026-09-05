# Structure and spacing audit

Audit complete for checkpoint 6f744e0. The working tree was clean while I read,
so all line numbers refer to that commit. The verdict is that the code is
correct and well-named but visually dense: methods run 60 to 200 lines with no
paragraph breaks, class members and top-level declarations are glued together,
several units hide a class inside a closure, and comments explain invariants
only in about a third of the files. Nothing in the toolchain enforces blank
lines, so this is authoring discipline.

## Spacing and scanability, systemic

These are the cheapest fixes with the largest effect on readability. Formatting
is dprint with oxc, which preserves blank lines but never inserts them, and the
example formatter also preserves them, so every missing gap below is authored.

- **Class members with no separation.** RunStore in
  `src/runtime/store.ts:79-145` has fields, constructor and four methods with
  zero blank lines. Same in Semaphore at `src/runtime/semaphore.ts:9-36`,
  AcpEventParser at `src/drivers/events.ts:211-212`, and AcpDriver where detect
  ends and the configureSession doc comment starts on the next line at
  `src/drivers/acp.ts:294-295`. Rule to apply: one blank line between every
  method, and between the field block and the constructor.
- **Import block glued to the first declaration.** cli.ts:23, acp.ts:17,
  events.ts:4, config.ts:7, control.ts:11, replay.ts:6, transcript.ts:6,
  store.ts:14, notice.ts:2, wait.ts:4, and drivers/cli.ts:10 where a comment
  follows the imports directly.
- **Top-level declarations run together.** types.ts:19-74 chains five zod
  schemas with no gaps. Same pattern in config.ts:15-17, control.ts:18-30,
  store.ts:26-53, background.ts:29-40, acp.ts:18-24, worktree.ts:39-40, 128-129,
  157-158 where three functions abut, output.ts:43-44 and 129-130. cli.ts
  registers eight commands back to back with no blank line between the end of
  one `.action` and the next `program` at lines 73, 85, 207, 214, 260, 287, 308,
  342, 407, 432, and wedges the RunOptions and ShowOptions interfaces between
  command chains at 74-85 and 208-214. Move option interfaces to the top and
  separate each command with a blank line.
- **Method bodies as single hunks.** Zero internal blank lines in:
  WorkflowRun.run at run.ts:578-668, WorkflowRun.agent 449-537, preflight
  234-292, executeChild 408-447; ManagedProcess constructor process.ts:63-187;
  cliArguments drivers/cli.ts:65-175; configureSession acp.ts:296-387 and
  AcpConnection.line 61-118; createWorktree worktree.ts:180-280 and ignoredState
  40-128; parseScript script.ts:82-202; runTurns agent.ts:230-286; render
  progress.ts:209-257; claudeOrCursorEvent events.ts:114-173. executeScript at
  sandbox.ts:53-255 is 203 lines with a single blank line at 209, and
  launchBackground at background.ts:45-177 has one at 157. The cli.ts run action
  100-207 has one at 183. Paragraph rule: a blank line before each awaited stage
  and between setup, guards, action and teardown.
- **Examples.** Eight of nine scripts have exactly one blank line, after `meta`.
  Sections such as schema constants, state declarations and the main loop abut,
  for example adversarial-verify.js:12-22, loop-until-dry.js:35-44 which
  declares six variables straight into a while loop, and
  multi-modal-sweep.js:43-69. judge-panel.js is the model to follow.

## Structure, composition and complexity, ranked

1. **executeScript is a class written as a closure** at
   `src/runtime/sandbox.ts:53-255`. Six inner functions share eight mutable
   locals: closed, settle, encodeResult, resolveResult, rejectResult,
   interrupted, instructions, releaseExecution. The pattern "evalCode or
   callFunction, check error, dump, dispose, throw or fail" is written out four
   times at 97-100, 163-169, 222-227 and 237-241. Proposal: a small GuestSession
   unit with those as fields and methods installBridge, deliver, pump, finish,
   plus one `unwrap(result)` helper for the QuickJS error pattern. deliverResult
   at 172-208 nests try inside if inside try; unwrap flattens it to two levels.
   Add a comment on hold and idle at 59-66 stating the invariant they protect:
   replay must not deliver cached completions while the guest still has pending
   microtasks, or delivery order changes.

2. **WorkflowRun carries five responsibilities and fourteen private fields** in
   `src/runtime/run.ts`. Child workflow handling alone spans scripts,
   childResolutions, savedChildren, archivedChildren, resolveChild 294-331,
   readChild 333-365, the archive closure inside preflight 238-259, and the
   manifest loader inlined into run at 592-617. Extract a ChildScripts unit
   owning those four maps, resolution, archival and `loadSaved(resumeDir)`. That
   removes roughly 150 lines and lets run read as a straight lifecycle. Then
   split run's 30-line finally at 637-666 into a `settle(status)` method so the
   nested try/finally/try/finally disappears. In agent at 449-537, separate
   identity, admission, replay call and record building into paragraphs, and
   comment the key context object at 461-474: it is the replay cache identity,
   and the list of config fields inside it is the definition of "what changes an
   agent's output." That invariant is currently undocumented.

3. **Repeated errno predicate.** `error instanceof Error && "code" in error &&
   error.code === "X"` appears in run.ts:338 and 607-612, cli.ts:245-247,
   worktree.ts:169 and 243-247, config.ts:71, notice.ts:14, control.ts:213-217
   and 232-236, process.ts:224. Several are six-line multiline conditions. One
   `isErrno(error, code)` in types.ts removes about forty lines and makes every
   catch block read as intent. The 15-line exists check at worktree.ts:237-251
   becomes three lines.

4. **ManagedProcess constructor** at `src/drivers/process.ts:63-187` builds line
   decoding, the exit promise, and the close/exit race inline. Extract
   `pipeLines(channel)` for 83-111 and `awaitExit(options, abort)` for 115-186;
   spawnError, backendExit, drainTimer and settled become fields or stay local
   to the extracted method. kill at 210-230 is if, try, if, catch, if; early
   return on the guard flattens it. The comments at 81-82 and 154-159 are
   exactly the right kind. Add a class comment describing the ownership model,
   since the supervisor, process group and IPC anchor are currently explained
   only in supervisor.cjs.

5. **cliArguments is three backends in one 111-line if chain** at
   `src/drivers/cli.ts:65-175`. Each branch is a cohesive unit: split into
   claudeArguments, codexArguments and cursorArguments with a five-line
   dispatcher. Each builder then paragraphs naturally into base flags, model and
   effort, tool policy, prompt delivery. In detect at 185-255, model discovery
   nests four deep inside else, try, if; extract `discoverModels(binary, cwd,
   signal)`.

6. **AcpDriver hides an AcpSession** at `src/drivers/acp.ts`. run at 389-458
   builds a 20-line prompt closure and returns `{ prompt, close }`, which is the
   DriverSession interface. A small AcpSession holding connection, parser and
   sessionId gives keepSession a home and makes run about 25 lines. In
   configureSession at 296-387 the predicate `option.category === X ||
   option.id === Y` appears five times including modelOptions 181 and detect
   264; extract `findOption(config, category, id)`. The two model paths at
   331-358 duplicate the "did not apply" and "acknowledged without reporting"
   messages; one `assertApplied` helper covers both and the effort branch.
   AcpConnection.line at 61-118 should split into handleServerRequest and
   settleResponse. This file has eleven lines at seven or more indent levels,
   the most in the repo.

7. **parseScript** at `src/runtime/script.ts:82-202`. The CallExpression visitor
   contains two 13-line blocks at 159-186 that differ only in the property name
   and target set; extract `literalStringProperty(node, name)` and each becomes
   one line. Header validation at 88-107 is a separate concern; name it
   `metaDeclaration(ast)`.

8. **launchBackground is a state machine in closure form** at
   `src/background.ts:45-177`. Six closures share done, cancelling, location and
   two timers. finishLaunch at 123-156 needs only temporary, worker and reply,
   so it can be a module function today. Group the three timers into one clear
   step. The comment at 137-138 is good and should be kept.

9. **createWorktree and ignoredState** in `src/runtime/worktree.ts`.
   createWorktree at 180-280 does validation, registration, git add with
   hook-failure logic, shared path materialization and baseline. Extract
   `validateSharedPaths` for 191-210 and `materializeSharedPath` for 236-273.
   ignoredState wraps a 60-line recursive visit closure; make it a module
   function taking the digest. The four-way OR at 302-307 in finishWorktree
   means "worktree changed"; name it.

10. **cli.ts duplication.** The signal handler plus Progress plus try/finally
    shape repeats in run 178-206, wait 317-341 and the worker 350-406, and the
    exit-code line repeats three times at 199-201, 334-336 and 395-397. One
    `runWithProgress(json, body)` helper collapses all three. The run action
    itself should split into applyOverrides, loadArgs and readSource.

11. **Smaller items.** events.ts claudeOrCursorEvent 146-172 does five things in
    the result branch; extract resultEvent. usage at 35-53 has a six-clause
    condition that a `finiteNonNegative` predicate halves. progress.ts:240 is a
    240-character template with a nested ternary inside a division; extract
    formatRow and elapsed. Named booleans wanted at agent.ts:145-149,
    schema.ts:130-136 and 177-185, script.ts:161-168, progress.ts:191-196,
    replay.ts:114-119.

## Comments

The good comments explain why: replay.ts:65-66 and 194-195, process.ts:154-159
and 173-174, sandbox.ts:95 and 231-232, run.ts:414-415 and 499-500,
agent.ts:52-53 and 61, guest.js throughout. Files with zero comments and
undocumented invariants:

- **store.ts** should state the run directory layout and why report.json is
  atomic while journals are append-and-flush, and why invocations.jsonl exists
  separately from journal.jsonl.
- **semaphore.ts** release hands the slot directly to the next waiter without
  touching the counter; one line prevents a future "fix."
- **types.ts** canonical is the replay key encoder and agentType exists only to
  be rejected; neither is stated.
- **cli.ts** the EPIPE handler at 45-53 and the IPC disconnect in the worker
  finally at 403-405 have no rationale.
- **run.ts event** throttles report saves to 250 ms at 160-166 with no comment
  on why activity is special.
- **transcript.ts:24** the 100 cap is a lineage depth guard, not a transcript
  size limit.
- **WorkflowRun, ManagedProcess, RunStore, Semaphore** have no class-level
  comment; Replay, Progress, AgentExecution and AcpConnection do, and those are
  the model.

Suggested order for the fixing agent: the spacing pass first since it touches
every file and is mechanical, then items 1 through 6 which are the real
structural debt, then the errno helper which is small and unlocks readability in
six files. Items 7 through 11 are worthwhile but independent. Cyclomatic counts
above roughly 15 flagged executeScript, the ManagedProcess constructor,
cliArguments, parseScript, launchBackground and claudeOrCursorEvent; all are
covered above, and none warrants a framework, only cohesive extraction.

## Implementation review

Verification done. Typecheck passes, source is dprint-clean, and I read every
changed source file against the checkpoint audit rather than relying on the pass
summary.

**Verdicts**

1. **Structure and composition: approve.** GuestSession is a real class with
   single-owner VM/handle lifecycle, `takeValue` makes handle transfer explicit,
   and `pump`/`deliver`/`deliverResult` are each one concern. ManagedProcess
   splits framing (`forwardOutput`) from exit observation (`waitForExit`) and
   the race state stays local, which is the right call. The three CLI argument
   builders plus a five-line switch read cleanly. AcpConnection's
   decode/route/settle split is good. `isErrno` removed every multiline errno
   predicate. The deliberately declined extractions (root keeps preflight and
   final cleanup, ACP prompt closure stays with its connection, no generic
   `runWithProgress`) hold up on merits: each keeps ownership visible where the
   audit's version would have hidden it.

2. **Nesting and complexity: approve.** No function now hides a class in a
   closure. The remaining high counts are inherently branchy and flat: `literal`
   in `src/runtime/script.ts:19` is an AST switch, `impossible` in schema.ts is
   a predicate ladder. acp.ts is still the deepest file, with the same 11 lines
   at seven-plus indent levels as the baseline, all inside `run`, `detect` and
   `configureSession`.

3. **Spacing and scanability: withhold on one bounded item.** Blank separation
   between members, imports, top-level declarations and paragraphs is applied
   everywhere I checked, and all nine examples now separate schemas, state and
   stages. But the claim "public lifecycle methods precede private helpers" is
   false in two classes. In `src/drivers/acp.ts:69-150` the private `line`,
   `handleServerMessage`, `completeRequest` and `send` come before public
   `request`, `start` and `close`, and the public mutable `onUpdate` field sits
   among private fields. In `src/drivers/events.ts:214` the public `finish`
   follows private `activity` and `tool`. Reorder those two classes and this is
   approved.

4. **Useful comments: withhold on one bounded item.** The new comments on replay
   holds, journals versus snapshots, semaphore handoff, observed-progress
   history and process ownership are exactly the right kind. One is wrong:
   `src/runtime/run.ts:385-386` puts the replay-identity comment on
   `resolveChild`'s memoization key. That key is a per-run resolution cache, not
   replay identity, and the comment tells a maintainer to keep it in sync with
   execution-affecting configuration. Delete those two lines. The correct copy
   at line 570 stays.

**Nonblocking suggestions**

- `configureSession` in `src/drivers/acp.ts:418-517` is the most improvable unit
  left: the `category === X || id === Y` predicate appears five times in the
  file, and the two model paths duplicate the "did not apply" and "acknowledged
  without reporting" messages. A `findOption(config, category, id)` and one
  `assertApplied` would cut about 25 lines.
- `CliDriver.detect` in `src/drivers/cli.ts:263-302` still nests model discovery
  else/try/if/try; a `discoverModels` helper would flatten it.
- Small paragraph misses: `src/runtime/script.ts:176-177` and `223-224`, and a
  blank line before the comment at `src/runtime/run.ts:570`.
- `WorkflowRun` marks `controller`, `semaphore` and `replay` readonly but not
  the six never-reassigned maps.

One housekeeping note: `dprint check` fails only on the untracked
`docs/reviews/fable-structure.md`, so `mise run check` will flag it until it is
formatted or excluded.

## Final verification

Verification complete. All bounded items are fixed as described and the full
project check passes, including formatting of the review doc.

**Bounded items verified**

- **AcpConnection order**, `src/drivers/acp.ts:29-206`. Public `process` and
  `onUpdate` fields come first, then the three private fields, then constructor,
  `request`, `start`, `close`, and only then the private `line`,
  `handleServerMessage`, `completeRequest`, `send`.
- **CliEventParser order**, `src/drivers/events.ts:62-224`. Public result
  fields, private state, constructor, `line`, `finish`, then the private event
  handlers. `finish` no longer trails `activity` and `tool`.
- **resolveChild comment**, `src/runtime/run.ts:388`. Now reads as a per-run
  path-stability note. The replay-identity wording occurs exactly once in the
  file, at the agent() replay key.
- **Paragraph misses**. Blank line after the meta parse in parseScript, blank
  line before the profile check, and a blank line before the replay-key comment
  are all present.
- **WorkflowRun maps**. All six never-reassigned collections are readonly. Only
  the genuinely mutable scalars and the archived-children array stay
  non-readonly.
- **Checks**. `mise run check` exits 0 with dprint, lint and example formatting
  clean, and the review doc itself is dprint-clean. Typecheck printed nothing.

I did not re-audit anything beyond these sites. The CI test concurrency change
is test-only per your description and does not touch the criteria under review.

**Verdict, for appending to the report**

1. Structure and composition: **approved**, reaffirmed.
2. Nesting and complexity: **approved**, reaffirmed.
3. Spacing and scanability: **approved**. The two class-ordering defects are
   fixed and the three paragraph misses are closed.
4. Useful comments: **approved**. The misplaced replay-identity comment is gone
   and its replacement describes what the memoization actually guarantees.

All four criteria pass. The nonblocking suggestions on `configureSession` and
`CliDriver.detect` remain optional and unchanged.

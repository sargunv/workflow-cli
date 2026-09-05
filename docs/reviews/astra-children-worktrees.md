# Bounded child-workflow and worktree review

Reviewed 2026-09-05 against VISION.md, docs/REFERENCE.md, current runtime
source, tests, and the recorded artifact decisions. Scope: child preflight,
snapshots and replay identity, worktree setup/cleanup, and cached artifacts.
Process ownership was not re-reviewed. No implementation files were changed.
Probes used fake drivers and temporary local Git repositories; no real backends
ran.

## P1: cleanup deletes meaningful edits to ignored copied files

Location: `src/runtime/worktree.ts`, `finishWorktree()`.

Cleanup checks commit/branch identity and ordinary Git status. Git status
excludes ignored files, and `git worktree remove` can delete them without
requiring force. Thus an agent can change local state explicitly copied into its
worktree and still have those changes silently removed.

Confirmed offline:

1. Commit a `.gitignore` that ignores `.env`.
2. Create parent `.env` containing `ORIGINAL=1`.
3. Create a worktree with `sharedPaths: [{path: '.env', mode: 'copy'}]`.
4. Change the copied worktree `.env` to `VALUABLE_CHANGE=1`.
5. Call `finishWorktree()`.

Observed: `kept: false`; the worktree directory no longer exists; parent `.env`
still contains `ORIGINAL=1`. The edited value is lost. This conflicts with
VISION.md's preserve-if-changed behavior and its explicit support for copying
environment files. It is distinct from the already-tested case of a clean
worktree containing a new commit.

Recommendation: include ignored local changes in the preservation decision. At
minimum, compare copied local state against a recorded creation baseline; also
define preservation for newly created ignored artifacts. Conservatively
retaining worktrees with ignored content is preferable to deleting unknown work.
Add a regression with an ignored copied file changed by the agent.

## P1: child snapshot persistence errors can be hidden as successful null results

Location: `src/runtime/run.ts`, the `workflow` host callback's children
directory creation and snapshot `writeFileSync()`.

These internal persistence operations are outside the runtime's `persist()`
failure handling. A `parallel()` wrapper can catch the error, return null, and
let the overall run complete successfully with no indication of an
infrastructure failure.

Confirmed offline: a valid parent returns `parallel([() =>
workflow('./child.js')])`. The valid child returns `1`. An `onReady` fault
injection creates `<run>/children` as a file before guest execution. The
internal snapshot-directory creation fails, but the final report is `status:
completed`, `result: [null]`, with no error and no logs.

Recommendation: route internal child archive/manifest persistence through the
same fatal persistence boundary as root/agent artifacts. Preserve the
reference's catchable errors for unknown user references and child syntax; do
not turn every child exception into an infrastructure error. Test this specific
write failure through `parallel()`.

## P2: literal object references bypass static child preflight

Location: `src/runtime/script.ts`, `parseScript()` CallExpression visitor.

Only `workflow('string')` contributes to `script.children`; the supported
`workflow({scriptPath: './child.js'})` form is ignored even when its path is a
plain literal. Consequently equivalent references have different launch
validation and snapshot timing.

Confirmed offline with an invalid child source:

```js
await agent('first side effect');
return workflow({scriptPath: './child.js'});
```

The object-reference version executes the first fake agent before failing on
child syntax. Replacing the reference with `'./child.js'` fails preflight with
zero agent calls. The same omission applies to inspecting a child's literal
backend requirements before beginning parent work.

Recommendation: recognize the supported pure-literal object form, resolve and
validate it consistently with literal string paths, and document what must
remain a dynamic reference. In particular, genuinely runtime-generated child
files need an intentional deferred-load route; do not accidentally make that
route impossible while improving static preflight.

## P2: named child references reconsult mutable registry state after preflight

Locations: `src/runtime/run.ts`, `preflight()`, `resolveChild()`, and the
`workflow` host callback.

The script map stores parsed children from preflight, but the host callback
first resolves a named reference again using live filesystem `access()`. The
launch-loaded child therefore becomes unreachable if an earlier agent
moves/deletes its registry file. A newly created higher-priority registry entry
could likewise change which child is selected after preflight.

Confirmed offline: `.workflow/workflows/child.js` initially exists and returns
`'launch snapshot'`. The parent awaits a fake agent that removes that file, then
calls `workflow('child')`. The run fails with `Unknown workflow child`, even
though preflight had loaded and retained the child script. An explicit file path
does not perform the same existence check at this stage.

Recommendation: snapshot the mapping from each preflight reference to its
resolved child identity as well as its source. Use that mapping throughout the
run. Dynamic references can resolve at their documented first-use boundary and
then acquire the same stable mapping.

## P2: partial worktree setup loses structured artifact metadata and the actual cause

Locations: `src/runtime/worktree.ts`, `createWorktree()`; `run.ts`,
`liveAgent()` worktree assignment.

The worktree is created before shared paths are installed, but its record is
returned only after successful setup. An error during installation leaves a real
locked worktree/branch and throws a generic message. `liveAgent()` never
receives its `WorktreeRecord`, and `errorText()` discards the nested cause.

Confirmed offline: configure copying a tracked `tracked.txt`, which collides
with the checked-out file. The journal's errored agent has no `worktree` field.
Git still lists the locked `workflow/<run>-1` worktree. The reason says only
`Worktree setup failed; preserved <path> (<branch>)`; it omits the collision
explanation. The overall run completes with null under the normal agent-failure
contract, so structured artifact discovery is particularly important here.

Recommendation: persist a worktree record immediately after creation and retain
it through setup failures. A typed setup error carrying the record and original
cause, or a creation callback that records ownership before copying, can provide
this without broad cleanup heuristics. Do not attempt automatic removal of a
partially prepared tree that may contain local work. Add assertions for
structured path/branch/base metadata and the actual failure reason.

## Child replay source selection needs an explicit durable contract

This is a verified gap in reconstructability, with policy underspecified by the
reference rather than a reason to blindly invalidate every child call.

Child snapshots are numbered source files such as `children/1.js`. There is no
persisted reference-to-source manifest, and resume never reads these copies. If
a cached parent agent originally generated a child file, the agent's cached
return does not recreate that file.

Confirmed offline: the first run awaits a fake `generate` agent that writes
`generated.js`, then runs it; that child calls `agent('inner')`. The run
completes and stores `children/1.js`. Delete only the generated original and
resume the same parent/args. The generator is cached, but the run fails with
ENOENT reading `generated.js`, despite the archived child source. Total live
calls across both runs remain just `generate, inner`.

docs/REFERENCE.md explicitly leaves changed-child cache coherence open. Choose
and document source selection on resume: when current files take precedence,
when a recorded snapshot can reconstruct a generated child, and how an
edited/new child becomes live. Persist enough identity/lineage to implement that
choice. At minimum, diagnostics should identify the available archived child
rather than leaving an opaque numbered copy.

The leaf replay keys already include effective backend/options, cwd,
schema/retry/timeout/shared-path settings, and profile preamble. Reusing an
unchanged leaf prompt/options after purely local child-code edits is not by
itself a demonstrated bug: it follows the longest-unchanged-agent-prefix
contract. Hashing the entire child source into every leaf key would
unnecessarily invalidate early calls when only later child code changes.
Separate stable child-source selection from agent-call cache identity.

## Cached artifact policy and validation

DECISIONS.md already explicitly chooses to preserve recorded worktree metadata
and existing artifacts without recreating deleted worktrees. docs/REFERENCE.md
confirms the reference does not specify recreation. That is a defensible
documented policy; this review does not treat non-recreation as a missing
implementation. A `kept` field on a cached record is historical metadata,
however, and should not be presented as a freshly verified claim that the path
still exists.

The four replay tests and three worktree tests passed. The two targeted child
runtime tests also passed. Those tests cover delivery order, divergence, torn
journals, clean-vs-committed worktrees, recursive-copy escape rejection, shared
child limits/arguments, and existing child preparation/cancellation. They do not
cover the concrete failures above. Process ownership remains under its separate
bounded approval.

## Follow-up after child/archive and ignored-content fixes

Reverified later on 2026-09-05. **Approved for this bounded child/snapshot,
replay-identity, and worktree-artifact scope at the reviewed snapshot.** The
concrete findings above are resolved in the verified paths. This is not full
VISION completion approval and does not extend the separate driver/protocol or
ownership reviews.

Eight worktree/replay tests and six targeted child/setup runtime tests passed,
covering the original ignored-copy/new-artifact preservation, literal object
preflight, stable named resolution, fatal dynamic snapshot write,
generated-child resume, and partial shared-path setup cases.

Source inspection confirms:

- Ignored content is hashed after copying and compared during cleanup. Unchanged
  copied state remains removable; changed copied state and newly created ignored
  artifacts are retained.
- Pure-literal object references participate in preflight. A stable
  reference-to-path map avoids resolving the same named child against a changed
  registry during the run.
- Child sources have a path/file/SHA256 manifest. Current files are preferred on
  a new/resumed execution; missing originals can use the preceding run's
  verified archived source. Computed references preserve the route for children
  generated during execution.
- Archive writes use fatal persistence handling. Shared-path setup errors carry
  the worktree record and the underlying cause.

An independent integrity probe deleted a child's original source, altered its
archived source without updating the manifest hash, and resumed a parent
wrapping the child in `parallel()`. The entire run correctly failed with `Saved
child source failed integrity check`; the error was not hidden as a successful
null result.

The adjusted unawaited-child test correctly distinguishes side effects before
root completion from mutation after the terminal report. It waits on a delayed
fake agent before attempting its late log.

### Additional partial-creation case found and fixed during follow-up

The initial follow-up identified one earlier setup boundary that the first
typed-error patch did not cover: `git worktree add` can register and populate a
worktree, then exit nonzero because its post-checkout hook failed.

An offline temporary-repository probe installed a post-checkout hook that
exited 1. At that intermediate snapshot, `createWorktree()` threw plain `Error`
with no record, while `git worktree list --porcelain` showed the real locked
worktree and branch. The parent then extended partial-creation recovery around
the add command.

The final source checks that the target was not already registered, attempts the
add, and checks live NUL-delimited worktree registrations on failure. An
actually created target receives `WorktreeSetupError` metadata and the original
failure; a retry against an already registered target does not claim it as newly
created.

The additional failing-post-checkout regression passed independently. It
verifies structured branch/kept metadata, the hook's diagnostic, the existing
worktree, and non-ownership on retry. This closes the partial-creation finding
within the reviewed scope.

All probes were offline and used fake drivers or temporary Git repositories.
Implementation files were not edited. The documented policy of retaining
historical cached-artifact metadata without recreating deleted worktrees remains
accepted; child snapshot source selection is now explicit in the implementation
rather than depending on opaque numbered copies.

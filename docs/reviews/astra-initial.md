# Initial adversarial implementation review

Reviewed 2026-09-05. This is an initial correctness review, not completion
approval. Scope: sandbox, replay, run ownership, worktrees, process handling,
and their offline tests. No real agent calls were made. The working tree was
being updated concurrently; findings below distinguish reproduced behavior from
fixes observed during review.

## P1: replay mistakes runnable guest work for edited control flow

`src/runtime/replay.ts`, `Replay.pump()`, assumes a `setImmediate` means every
guest has drained its microtasks. `src/runtime/sandbox.ts`, `pump()`, executes
only 1024 jobs and schedules another immediate when jobs remain. The two
scheduler contracts disagree.

Offline reproducer, using a fake driver that delays prompt `a` by 50 ms:

```js
export const meta = { name: 'probe', description: 'probe' };
const a = agent('a');
for (let i = 0; i < 5000; i++) await Promise.resolve();
const b = agent('b');
return [await a, await b];
```

The first run executes `a,b`. Identical replay executes `b` live and reports
`Edited control flow no longer reaches the next cached invocation`. Results
still happen to match with an echo driver, but real editing agents would repeat
side effects and spend quota. This reproducer does not need children or
filesystem I/O.

A second confirmed reproducer was:

```js
return parallel([() => agent('parent'), () => workflow('child')]);
```

Here `.workflow/workflows/child.js` returns `agent('child')`, and the fake
parent driver waits 40 ms. Named-child resolution performs asynchronous
filesystem access; identical resume reran `child` live with the same false
divergence. A `holdPreparation()` change appeared during review to address child
preparation; it was not independently revalidated here. It does not by itself
address the runnable-microtask reproducer above.

Required invariant: declare replay divergence only when all guest runtimes are
actually blocked, no child preparation can produce an invocation, and the
expected invocation is unreachable. Coordinate this state explicitly with the VM
scheduler; increasing a timeout or imposing a pipeline barrier does not
establish it. Keep the removed-call no-deadlock regression too.

## P1: unawaited child outlives a completed run

Initially, `WorkflowRun.execute()` registered agent promises in `pending`, but
not child promises. This script returned a completed report with no logs:

```js
workflow('child');
return 'parent done';
```

The named child contained `log('child still running'); return 1;`. After a 30 ms
host wait, the already-returned completed report had acquired the log line. Root
teardown therefore did not own all child work or prevent writes after
completion. A child awaiting forever could also retain its VM.

The parent added child promises to `pending` and abort checks during this
review. That change was observed in source but not independently retested here.
Add a regression proving that root finalization cancels and joins unawaited
named children and that reports/transcripts cannot mutate after `runWorkflow()`
resolves.

## P2: final-result validation occurs after lossy conversion

`executeScript()` calls `vm.dump(outcome.value)` before applying the host JSON
schema. `vm.dump` has already coerced or removed unsupported guest values, so
validation cannot catch them. Confirmed offline outputs:

| Guest result       | Host result                   |
| ------------------ | ----------------------------- |
| `{x: undefined}`   | `{}`                          |
| `{x: NaN}`         | `{x: null}`                   |
| `{f: () => 1}`     | `{}`                          |
| `function abc(){}` | the string `function abc(){}` |

Use strict guest serialization for the final result as well as agent arguments.
Preserve an intentional convention for an absent top-level return, but reject
nested undefined, functions, and non-finite numbers before information is lost.
Test final-result behavior separately from agent-argument validation.

## P2: copied shared directory follows symlinks outside the repository

`createWorktree()` validates the realpath of each configured shared root, then
uses recursive `cp` with `dereference: true`. It does not validate descendant
symlink targets.

Confirmed with an offline temporary Git repository: configure copying `assets`,
put `assets/secret` as an absolute symlink to a sibling file outside the
repository, and call `createWorktree()`. The new worktree contains the outside
file's contents. The existing test checks only a top-level `../` path and does
not cover this case.

Define recursive symlink semantics explicitly. If the repository boundary is
meant to constrain copying, reject escaped descendant targets before copying;
alternatively preserve symlinks and document the sharing boundary. Do not imply
that the current root check prevents recursive escapes.

## Fixed and independently rechecked: Date descriptor bypass

The initial Date proxy intercepted property reads but exposed the original clock
through its own property descriptors:

```js
Object.getOwnPropertyDescriptor(Date, "now").value();
Object.getOwnPropertyDescriptors(Date).now.value();
```

Both returned current epoch milliseconds in the initial offline probe. The
parent subsequently replaced `NativeDate.now` itself with a non-configurable
throwing function. Rechecking the first expression now rejects with `Date.now()
is nondeterministic`.

Direct lexical probes for `NativeDate`, `dispatch`, and `__dispatch` returned
`undefined`; separating bootstrap evaluation from user-source evaluation does
establish that lexical boundary for these tested names.

## Validation observed

`pnpm test` passed all 20 then-present offline tests. Extra probes above used
fake drivers or temporary Git repositories outside the checkout. Passing the
existing suite did not cover the reproduced child/microtask replay, final-value
conversion, or recursive-copy cases.

The process wrapper owns detached process groups, now sends SIGKILL on leader
exit as well as close, and bounds cancellation escalation. No new independently
reproduced process-wrapper defect was established in this review. This is not a
claim of complete process/lifecycle coverage.

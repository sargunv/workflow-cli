# Bounded adversarial supervisor review

Reviewed 2026-09-05. Scope: the new process-group supervisor, its owner-death
and shutdown behavior, and the related startup regression. This is not full
VISION completion approval. No implementation files were edited and no real
backends were invoked. Extra probes used plain Node subprocesses; all
probe-owned processes were explicitly cleaned up.

## Verdict at the reviewed snapshot

The supervisor fixes the previously reproduced forced-startup discovery orphan.
Its ownership model is simpler than reconstructing descendants from process
listings or retaining historical group IDs. Ordinary completion, owner death,
TERM escalation, and inherited-pipe cleanup pass the committed tests.

One additional bounded-wait defect was reproduced: after the supervisor exits,
inherited output descriptors can prevent Node's `close` event forever, and
`ManagedProcess.exited` currently resolves only from that event. The parent
accepted a bounded post-exit drainage fix during review; that change was not yet
verified when this report was written.

## Evidence for the ownership fix

Command: `pnpm exec tsx --test test/process.test.ts test/cli.test.ts`. All 12
tests passed in about 11.4 seconds, including:

- Suspended startup worker followed by forced termination: the discovery process
  now exits, no leaf call occurs, and the run is no longer running.
- SIGKILL of the owning process: the independent supervisor receives IPC
  disconnect and terminates the backend group.
- Normal vendor exit while ordinary grandchildren retain inherited pipes: the
  grandchildren are killed and process completion settles.
- Deadline/stop with TERM-ignoring descendants: the group is killed after the
  grace period.
- Nonzero vendor exit and vendor spawn failure: actual exit/error information
  reaches the owner despite the supervisor's own normal SIGKILL cleanup.
- The previous terminal-persistence, log-relocation, and FIFO-preflight
  regressions remain green.

Source inspection confirms that disconnect and SIGTERM handlers are installed
before vendor spawn, the vendor inherits only descriptors 0/1/2, and the
supervisor reports actual vendor termination over its separate IPC channel
before killing its group. The owner no longer sends redundant group signals
after the supervisor's recorded exit.

## Remaining P2: output drainage can defeat deadline and stop after supervisor exit

Location: `src/drivers/process.ts`, `ManagedProcess.exited`, `kill()`, and
`stop()`.

The completion promise waits for the supervisor ChildProcess `close` event. Node
can emit `exit` while inherited stdout/stderr handles are still open elsewhere.
The deadline subsequently calls `stop()`, but `kill()` correctly refuses to
signal a process group after its direct-child anchor has exited. Consequently
neither the deadline nor its escalation can make the completion promise settle
if a surviving process retains an output descriptor.

Two independently confirmed offline cases used a 100 ms timeout and were still
unresolved after 1400 ms, beyond the timeout plus one-second grace:

1. A vendor starts a detached Node grandchild with inherited stdio, calls
   `unref()`, and exits normally. The supervisor kills its own group, but the
   new-session grandchild keeps the output pipe open. Observed supervisor
   signal: SIGKILL. Only manual termination of the test-owned escaped group
   allowed the promise to resolve.
2. A plain long-running Node vendor prints its PID. The probe sends SIGKILL only
   to its supervisor, simulating an unexpected supervisor crash. The vendor
   retains the pipes and the same timeout hang occurs. No detached grandchild is
   needed in this case. The reviewer then terminated the exact test-owned vendor
   PID, allowing completion to settle.

The first case exceeds the promised process-group containment boundary, but it
must not defeat the CLI's bounded wait/stop behavior. The second case also shows
that the intended missing-terminal-IPC error is not sufficient if it is
evaluated only after a `close` event that never arrives.

Required correction: observe supervisor `exit` independently, allow a bounded
interval for normal buffered output to drain, and then destroy remaining streams
and settle an explicit infrastructure/cleanup-uncertainty error if `close` has
not followed. Retain normal output and exit information when drainage succeeds.
Do not reinstate late numeric process-group kills.

The uncertainty also needs to survive the driver/runtime boundary: an ordinary
nullable agent failure should not cause `finishWorktree()` to remove an
unchanged worktree while a potentially surviving process can still write there.
Preserve that worktree and avoid claiming all workers were joined.

## Fix proposed during this review

The parent proposed a one-second post-supervisor-exit stream-drain limit: normal
close clears it; expiry destroys stdio and settles an explicit
output-drain/infrastructure failure. This addresses the reproduced wait defect
in design. Verify the implementation with both cases above and check
worktree-preservation/error propagation before closing the finding.

Broader schema, backend semantics, and full-project completion remain outside
this bounded review.

## Bounded drainage follow-up

Reverified later on 2026-09-05 after the bounded-drain and
`ProcessOwnershipError` changes. The two original probes now settle without
manual intervention in about 1067 ms (escaped descendant) and 1061 ms
(supervisor crash), both with code 1 and `cleanupUncertain: true`. The
test-owned surviving processes were then explicitly cleaned up.

All six tests in `test/process.test.ts` passed. The targeted `uncertain process
cleanup` integration test in `test/run.test.ts` also passed: `parallel()` does
not hide this infrastructure error, the entire run fails, and the clean agent
worktree remains present with `kept: true`. Source inspection confirms CLI
execution and ACP close/pending-request handling propagate
`ProcessOwnershipError`, and runtime worktree finalization bypasses normal
removal for that error.

The original indefinite-drain finding is fixed in these tested paths. One narrow
classification defect remains at this follow-up snapshot:

### P2: unexpected supervisor death without retained pipes is still classified as ordinary failure

`cleanupUncertain` is currently set only when the drainage deadline expires. If
the vendor closes its own stdin/stdout/stderr and keeps running, killing the
supervisor yields `close` immediately, despite the vendor remaining alive. The
missing terminal IPC is reported as an ordinary error with `cleanupUncertain:
false`.

Confirmed offline: a plain Node vendor writes its PID to a temporary file,
closes descriptors 0/1/2, and runs an interval. After SIGKILL to only its
supervisor, the result was:

```json
{
  "code": 1,
  "cleanupUncertain": false,
  "error": "Backend supervisor exited unexpectedly (SIGKILL)"
}
```

`process.kill(vendorPid, 0)` simultaneously confirmed the vendor still lived;
the reviewer then killed the exact test-owned vendor. This error does not become
`ProcessOwnershipError`, so the runtime can still treat it as a nullable agent
failure and perform normal clean-worktree removal.

Correct the classification of missing terminal IPC after a supervisor was
successfully spawned: drained pipes do not prove descendant cleanup. Genuine
supervisor spawn failure can remain distinct because no vendor was started. Add
a regression with a live vendor that closes stdio, asserting uncertainty rather
than merely a nonzero result. The broader ownership design and the original
bounded-drain correction remain valid.

## Final bounded ownership/control verdict

Reverified later on 2026-09-05 after the missing-terminal-IPC classification
fix. **Approved for the bounded ownership/control scope reviewed here.** No
remaining concrete blocker from these reviews is open at this snapshot. This
approval does not cover broader schema/driver semantics or full VISION
completion.

Evidence:

- All seven `test/process.test.ts` tests pass, including the new live-vendor
  closed-stdio/supervisor-crash regression and the previous inherited-pipe,
  owner-death, graceful-stop, deadline, and exit-information cases.
- The targeted `uncertain process cleanup` runtime integration passes again: the
  whole run fails and preserves an otherwise clean worktree.
- An independent repeat of the exact final classification probe confirmed that
  the vendor was still alive while the returned result now had code 1,
  `cleanupUncertain: true`, and `Backend supervisor exited unexpectedly
  (SIGKILL)`. The reviewer then terminated the exact probe-owned vendor.
- Source inspection confirms the exemption requires a successful SIGKILL of the
  still-anchored owned group. Missing terminal IPC otherwise remains uncertain;
  a drainage timeout remains uncertain regardless. No late process-group signal
  was reintroduced. Deadline reset preserves the stopped-state guard and cleanup
  clears the active deadline.

This closes the original startup/control findings and their bounded
supervisor/drainage follow-ups. Processes deliberately entering new sessions
remain outside ordinary process-group containment; observable cleanup
uncertainty now fails explicitly and protects worktrees instead of hanging or
implying successful cleanup. No real backends ran during this review.

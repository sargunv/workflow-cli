# Initial adversarial background/control review

Reviewed 2026-09-05. This is a bounded review of background startup, run
control, wait, persistence, and their CLI wiring; it is not completion approval.
Implementation files were not edited. All launched agent processes used
`test/helpers/fake-claude.cjs` through a temporary isolated PATH; no real agents
were invoked. All probe workers were stopped and joined or otherwise cleaned up
before completing the review.

## P1: terminal persistence failure leaves the control server alive forever

Location: `src/runtime/run.ts`, `WorkflowRun.run()` finalization.

The final `this.store.save()` precedes both `await closeControl?.()` and
removing the abort listener. If saving throws, neither cleanup operation runs.
The background worker's outer CLI catch prints the error, but the
still-listening TCP server keeps the worker alive. Its old report continues to
say running, and a successful ping makes `inspectReport()` believe that the
workflow is still active. `wait` and `stop` can therefore wait forever after the
actual agent work has already stopped.

Confirmed offline fault injection:

1. Start a background script returning `agent('block fixture')`.
2. Wait until its agent is marked running.
3. Create a directory at `<run>/report.json.tmp`, making `atomicJson` fail with
   EISDIR. This injects a filesystem write failure without modifying application
   code.
4. Send authenticated `stop`, then wait 400 ms.

Observed: stderr prints `workflow: EISDIR ... report.json.tmp`; the persisted
report still says `running` with one active agent; authenticated `ping`
continues to succeed. After removing the injected directory and terminating the
stranded worker, `inspectReport()` correctly reports `interrupted`.

Required correction: control-server closure and listener removal must be
guaranteed by an outer cleanup `finally`, independent of successful terminal
report persistence. Preserve/report the original storage error. Add a subprocess
regression with a failed terminal write and prove that wait does not remain
attached to an idle control server.

## P1: failed startup acknowledgement processing leaves an active run behind

Location: `src/background.ts`, `launchBackground()` message handling and the
asynchronous log-relocation catch.

The worker starts executing after sending `ready`. The launcher marks its
handshake done, then renames the launch logs. If either rename fails, the catch
only disconnects/unrefs the detached worker and rejects. Thus the CLI reports
startup failure even though a real run has already started and continues
independently.

Confirmed offline fault injection:

1. Launch a background script returning `agent('block fixture')`.
2. As soon as its run directory appears, create `<run>/stdout.log` as a
   directory before the launcher relocates its log file.

Observed: the launcher exits 1, stdout is empty, and stderr reports the rename
EISDIR. Nevertheless `inspectReport()` says `running`, and the fake driver's
call file contains `block fixture`. Both `.launch-*` and the run directory
remain. The reviewer subsequently stopped the run through its control endpoint
and observed terminal `cancelled`.

Required correction: choose a consistent ownership outcome. Either make
diagnostic relocation failure nonfatal, return the ready run ID with an explicit
warning and retained-log location, or cancel/join the worker before reporting
launch failure. Do not return an unqualified failed launch while quietly leaving
its agents running. Apply the same ownership rule to invalid acknowledgements,
IPC failures, and startup timeout paths.

## P2: preflight can block startup and stop indefinitely, then acknowledge ready after cancellation

Locations: `src/background.ts` readiness wait; `src/runtime/run.ts`
`preflight()` script reads and ordering before `onReady`.

The launcher has no readiness deadline. Child script preflight reads are
unbounded and do not reject nonregular files. Cancellation sets the run signal
but does not break those reads; there is also no cancellation check after
preflight and immediately before sending `ready`.

Confirmed offline reproducer:

1. Make `child.js` a FIFO using `mkfifo`.
2. Launch a background parent whose body is `return workflow('./child.js')`.
3. Locate the run directory and send authenticated `stop` while preflight is
   waiting to read the FIFO.

Observed after 400 ms: stop had acknowledged, but the launcher had not exited or
printed a ready response and the run remained `running`. Writing a valid trivial
workflow into the FIFO released the read. The launcher then exited 0 and printed
`type: ready`, despite the run ending with status `cancelled`.

Required correction: reject unsupported nonregular script sources, make
preflight cancellation effective, bound startup with a documented policy, and
check abort state before readiness acknowledgement. A deadline needs an owned
shutdown path; merely rejecting the launch promise would recreate the preceding
active-run-on-launch-failure bug.

## Verified behavior and limits of this review

- `pnpm exec tsx --test test/cli.test.ts` passed both CLI subprocess tests. They
  cover normal background readiness/completion, skip, stop, wait, cached resume,
  and an unavailable-backend launch failure.
- A separate offline two-run probe rewrote run A's endpoint port to run B's port
  while retaining A's credentials and identity. Stopping A through that
  stale/wrong endpoint was rejected and B remained running. The run-ID/token
  checks prevented cross-run control in this case.
- Sending SIGINT followed immediately by SIGTERM to an active fake-backed worker
  produced a terminal cancelled report. Repeated-signal handling worked in this
  tested path.
- The existing distinction between connection refusal and a ping timeout avoids
  treating a merely busy runtime as definitely dead. The above persistence bug
  is different: its stranded server actually answers ping.
- An initial direct `node --import tsx --test ...` invocation could not resolve
  the relative loader after subprocess cwd changed; rerunning with the package's
  normal `pnpm exec tsx` runner succeeded. This was a test invocation issue, not
  evidence against the packaged CLI.

This review did not establish complete robustness against SIGKILL, PID reuse,
machine crashes, or hostile local users. Those are not covered by the successful
normal-path control tests.

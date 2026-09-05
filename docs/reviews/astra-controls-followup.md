# Background/control follow-up review

Reviewed 2026-09-05 against the current source after the fixes described in
`astra-controls.md`. This is a bounded control/lifecycle verdict, not full
VISION completion approval. No implementation files were changed and no real
agents were called. Tests and the additional process probe used the offline fake
Claude fixture; the probe's worker and discovery process were cleaned up.

## Verdict

The three original findings are addressed in the tested paths. One concrete
process-ownership gap remains in forced startup escalation: the launcher can
kill its worker and return while a detached discovery subprocess survives.
Normal cooperative cancellation passes; forced cleanup is not yet complete.

## Original findings reverified

`pnpm exec tsx --test test/cli.test.ts` passed all six tests in about 5.1
seconds. The new tests exercise the same fault injections as the initial review:

| Original issue                                                 | Current evidence                                                                                                                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Terminal report save failure stranded the control server       | Creating `report.json.tmp` as a directory, then stopping a blocked fake agent, now yields `interrupted`; subsequent ping rejects. `run()` closes control in a finally independent of successful report persistence.            |
| Startup log relocation failure left an unacknowledged live run | Injecting a directory at `stdout.log` now returns exit 0 with the ready run identity, a warning, and retained log location. The run remains controllable and stops normally.                                                   |
| FIFO child preflight blocked readiness and cancellation        | A FIFO child now fails before readiness with a regular-file error. A separate delayed-discovery test shows a 500 ms startup deadline cancelling a 5 second discovery attempt, no leaf call, and a non-running final run state. |

The normal skip/stop/wait test and background completion/resume test also
passed. The latter now verifies cached transcript lineage. Source inspection
confirms abort checks after preflight and readiness, cancellable discovery, and
final control/listener cleanup protected by nested finally blocks.

## Remaining P2: forced startup escalation loses detached discovery processes

Locations: `src/background.ts`, `launchBackground()` cancellation escalation;
`src/drivers/process.ts`, detached `ManagedProcess` spawning.

The launcher sends cancellation over IPC, then escalates using
`worker.kill('SIGTERM')` and `worker.kill('SIGKILL')`. These signal only the
workflow worker. Its discovery children have their own detached process groups.
If the worker cannot process cancellation, killing it also kills the code
responsible for terminating those groups. The launcher has no independent
ownership path for them.

Confirmed offline probe:

1. Use the unmodified fake Claude fixture with
   `WORKFLOW_FIXTURE_DISCOVERY_DELAY=20000`.
2. Configure `launchTimeoutMs: 500` and `discoveryTimeoutMs: 30000`.
3. Start `run --background` for a trivial agent workflow.
4. Read the starting report to obtain the worker PID; identify its exact
   discovery child PID with `pgrep -P`.
5. Send SIGSTOP to the worker after that child exists, simulating an
   unresponsive owner so the forced escalation path is required.

Observed: the launcher exited 1 after 5619 ms with the expected launch timeout
diagnostic, and `inspectReport()` reported `interrupted`. Nevertheless
`process.kill(discoveryPid, 0)` still succeeded: the discovery subprocess
continued running after the launch operation had completed. The reviewer then
killed that exact discovery process group. No leaf agent was started.

This is not a failure of the ordinary cancellation test: the suspended worker
cannot handle its IPC or signal callbacks, which is precisely why the launcher
has a hard-kill escalation path. A native ACP discovery server can have the same
separate-group ownership problem.

Required invariant: the independent owner performing forced startup cleanup must
also terminate and account for startup descendants before declaring shutdown
complete. Possible designs include retaining startup subprocesses in the
launch-owned process group until readiness, or communicating owned child group
identities to a supervisor that survives worker failure. Merely changing
`worker.kill` to a worker-group kill does not cover children that remain in
separate detached groups.

Add a regression that forces the unresponsive-worker path and checks the
discovery process itself has exited, not just the worker and report status. The
correction should preserve the existing normal driver process-group cleanup and
avoid killing unrelated processes.

## Scope limits

This follow-up does not certify every persistence-error route, every backend
transport, or SIGKILL/crash recovery generally. It confirms the original control
fixes and reports the additional independently reproduced forced startup
ownership gap. Broader completion requires the remaining scoped reviews and
validation evidence.

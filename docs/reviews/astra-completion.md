# Independent completion review

Date: 2026-09-05. This is the final whole-project adversarial review requested
by the user, covering VISION.md, the recorded reference consultation,
DECISIONS.md, the bundled authoring skill, the eight recipes, and the current
implementation. Earlier bounded reviews informed the threat model; they were not
treated as a completion approval. This reviewer used offline tests and temporary
probes only. The root agent is separately checking the terminal, package, and
final build.

## Initial verdict

Completion approval is withheld until the concrete findings below are fixed and
rechecked. All major requested feature areas are implemented; this is not a
missing-feature inventory. The stale pending list in STATUS.md was not treated
as implementation evidence. Existing offline tests passed 68/68 during this
review, including all eight recipes, but did not expose these boundary failures.

## Findings from the whole-project pass

1. **Blocking: cached replay persistence errors escape the run lifecycle.**
   `Replay.pump()` writes the cached finish event from `setImmediate` without
   delivering exceptions to the promise returned by `call()`. An offline probe
   matched one cached invocation, replaced the new trace file with a directory
   before its scheduled completion, and observed `uncaughtException: EISDIR`.
   The call never rejected. This bypasses runtime infrastructure failure,
   cancellation, report finalization, and ordinary worktree/control cleanup.
   Scheduled replay failures must reject the pending operation(s) and enter the
   root's fatal infrastructure path.

2. **Blocking: schema contradiction checks reject valid instance data.**
   `checkBounds` recursively visits every object, including `const`, `enum`, and
   annotation payloads. The valid schema
   `{type:'object',properties:{minimum:{type:'number'},maximum:{type:'number'}},const:{minimum:5,maximum:1}}`
   throws `Unsatisfiable schema: minimum exceeds maximum`. Independent probes
   also reproduced this in nested enum data and default annotations. Traverse
   only draft-07 schema-bearing keywords, not arbitrary JSON objects. The
   original-schema contract forbids these false refusals.

3. **Blocking: two transcript writes can become successful workflow nulls.** The
   correction-marker and validation-error writes inside `liveAgent` bypass
   `persist`, unlike backend event transcript writes. Their errors enter the
   ordinary leaf failure catch; `parallel` can then finish successfully with
   null. Apply the fatal persistence path consistently and fault-test these
   specific writes.

4. **Guidance mismatch:** the primary command in `examples/README.md` uses
   `workflow run --model`, but the inspected CLI has no such option. The eight
   review recipes inherit model configuration rather than reading `args.model`.
   Supply the documented flag or use an actually supported invocation.

5. **Capability accounting:** CLI terminal events always call `usage`, including
   when no usage object was reported. That manufactures known zero counters and
   defeats `unreportedAgents`. Preserve unknown usage when counters are absent.

6. **Unsupported option silently accepted through profiles:** `agentType` is
   rejected before profile merging, while profile schema permits it. A selected
   profile containing `agentType:'Explore'` silently drops its intended
   behavior. Reject it in the effective options or disallow it in profile
   configuration.

7. **Terminal output:** human report headings/logs are sanitized, but a string
   final result is appended verbatim. Escape/OSC bytes from a worker result can
   therefore act on the terminal. Preserve multiline result formatting while
   neutralizing terminal control sequences; sanitize displayed paths as well.

## Requirement and principle audit

| Area                             | Assessment and evidence                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Script shape and static metadata | Acorn enforces the initial pure literal export and rejects imports/other exports; plain JS async body, args and finite JSON results are exercised in the sandbox tests.                                                                                                                                                                                                                                                              |
| Sandbox                          | QuickJS supplies no host I/O/module loader. Bridge captures remain in a separate lexical scope; Date descriptor/constructor routes and randomness are covered. CPU/microtask and memory limits are explicit, and abort settles pending host operations.                                                                                                                                                                              |
| Primitives and limits            | Pipeline has no stage barrier and retains original item/index; throwing stages and thunks produce per-item null. Shared semaphore, 1000 leaf cap, 4096 item cap, per-call phases, narrator logs and one-level child nesting are implemented.                                                                                                                                                                                         |
| Replay                           | Invocation identity and completion order are separately journaled; tests exercise reversed completions, edited suffixes, removed calls, delayed child preparation and runnable guest microtasks. Finding 1 prevents approval until fixed. Crashes are explicitly not exactly-once execution.                                                                                                                                         |
| Children and snapshots           | Literal path/object/name references preflight; stable resolution, runtime-generated computed references, verified manifests and current-source preference are documented. Missing sources can use verified prior snapshots. Cached transcript lineage and historical worktree metadata remain inspectable.                                                                                                                           |
| Schema contract                  | Original validation and native/prompted strategy selection, synchronous author errors, bounded corrections and retained ACP sessions exist. CLI corrections contain only prior output/schema/feedback, not the original task. Finding 2 and transcript failure handling require repair. General satisfiability is explicitly not promised.                                                                                           |
| Configuration and selection      | Global/local configuration, CLI backend/concurrency, profile merges, transport/sandbox/schema/shared-path settings and strict validation are present. Findings 4 and 6 concern model guidance and unsupported profile options.                                                                                                                                                                                                       |
| Drivers                          | Claude/Codex/Cursor CLI and native OpenCode/Kimi/Qwen ACP share one runtime interface. Recorded streams and protocol tests cover terminal status, tools, model changes, effort choices, permissions and correction continuity. Unsupported ACP policies/minimal modes fail closed; unsupported effort warns. Actual model/default uncertainty is reported. Finding 5 affects unknown usage.                                          |
| Worktrees                        | Fresh HEAD branches, lock, shared-path validation, changed/committed/ignored artifact preservation, copied ignored baselines, typed partial setup records and failed checkout-hook ownership are implemented and tested. Parent/child cancellation shares ownership.                                                                                                                                                                 |
| Process and run control          | Dedicated supervisors handle owner death and ignoring descendants; bounded post-exit stream drains and missing terminal IPC mark cleanup uncertainty. That failure cancels the root and preserves its worktree. Private authenticated run identity avoids signalling stale persisted PIDs. Background readiness, startup failure, skip/stop/wait and repeated signal paths have offline integration tests.                           |
| Output and inspection            | Coalesced progress, phase/agent tree, elapsed/tool/activity rows, compact summaries, separate agent/transcript/journal drilling and large-result spill are present. Cached costs are separated from new costs. Finding 7 and unknown usage prevent unqualified UX approval.                                                                                                                                                          |
| Permissions and leaf context     | First-run/info notice, bypass drivers, explicit supported policies, worktree caveat, container guidance, prompt-only task context, authority boundary, native system append where available and request-field model/effort/policy are implemented. Backend-owned instruction loading is explicitly delegated.                                                                                                                        |
| Authoring and recipes            | Skill covers when to orchestrate, info-first capability discovery, full API, pipeline/barrier choice, resume/journal diagnosis, output/resource behavior and all eight patterns. Exact recipe files execute offline with schema validation; tests cover failed votes, blind reviewers, incomplete panels/ties, rejected-ID deduplication, disabled-budget fallback, missing search coverage, critic evidence and explicit omissions. |
| Packaging and maintenance        | Node 24 ESM CLI build, npm bin, bundled skill/recipes/docs, mise tasks and offline CI matrix are configured. Root's separate package/terminal validation remains required evidence, not inferred from source inspection.                                                                                                                                                                                                             |
| Deliberate deviations            | Node/QuickJS, disabled budget, profiles instead of agentType, backend-owned MCP, foreground default plus optional background, schema correction transport differences and historical cached artifacts have rationale/alternatives/reversal criteria in DECISIONS.md. These explicit choices are consistent with the vision's decision principles.                                                                                    |

## Scope of confidence

The six live backend verification records are evidence supplied by the project,
not fresh sessions run by this reviewer. They are narrow, versioned probes and
do not establish every model, permission setup, or future vendor version. The
review does not promise arbitrary process-session containment, exactly-once
external effects, or general JSON Schema satisfiability; these limits are
documented. Approval requires the follow-up section below to supersede the
initial withheld verdict with current evidence.

## Fix recheck

All seven initial findings have been addressed in the reviewed source. The
independent full offline suite now passes **78/78** tests. Specific evidence:

- Repeating the cached-finish path replacement now rejects the replay promise
  with EISDIR without an uncaught exception. The regression covers all pending
  waiters, and the runtime's existing fatal-error wrapper receives rejection.
- Repeating the transcript path fault during validation now returns a failed
  root report, not a completed workflow containing null. Correction and
  validation transcript writes both use the fatal persistence wrapper.
- Schema traversal now distinguishes schema nodes from instance data. A further
  adversarial pass identified optional impossible properties, irrelevant type
  bounds, and satisfiable alternatives as additional false-refusal cases; the
  replacement checks only proven active contradictions. Five independent
  counterexamples now compile and validate their intended instances.
- `run --model` is implemented, validates nonempty input, updates effective run
  defaults and has a CLI regression. The recipe command is now executable.
- Missing CLI usage remains unknown. Claude cache-input counters are counted;
  absent cost is not invented. Unsupported agentType and nested profile
  selections are rejected by profile configuration validation.
- Human result strings and displayed spill paths are sanitized while line breaks
  and tabs remain readable. Stored and JSON-mode values remain intact.

The final suite also includes the other reviewer's capability corrections:
Cursor final-answer/catalog extraction, authenticated minimal-mode declaration,
model-dependent ACP configuration, static-profile backend preflight, and shared
in-flight discovery. I inspected those changes and their fixture/regression
coverage. The saved pseudo-terminal transcript independently shows phase groups,
live activity/tool counts, frozen completed durations and a fast item's verify
stage starting while another item's find stage is still active.

## Final verdict

**Approved. No remaining blocking findings were identified.** This supersedes
the initial withheld verdict and the historical findings above.

| Required conclusion         | Verdict                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full scope completed        | **Yes.** The implemented product covers the VISION scope, with the explicitly deferred facilities and justified deviations documented rather than half-implemented or silently substituted.                                                                                                                                                                       |
| Code high quality           | **Yes.** The implementation has clear runtime/driver boundaries, isolated guest execution, faithful replay ordering, explicit persistence failures, process ownership, conservative artifact preservation and meaningful failure-path regressions. The discovered defects were repaired at their ownership/validation boundaries.                                 |
| UX high quality             | **Yes.** The CLI supports the complete start/observe/skip/stop/wait/resume loop, concise progressive output and detailed opt-in inspection. Unavailable capabilities, unknown accounting and retained artifacts are explicit. Real pseudo-terminal and installed-package exercises support the source-level assessment.                                           |
| Guidance correctly followed | **Yes.** The authoring skill and runnable examples follow the reference's pipeline, evidence, failure-disclosure and resume guidance. The project records its reference consultation, versioned live observations and deliberate deviations. Offline tests remain separate from quota-consuming probes, and package contents include the guidance they advertise. |

The optional JSON collection consistency issue was also tightened: Map, Set and
RegExp values now fail instead of silently becoming empty objects, while
explicit `toJSON` conversion is supported and documented. I independently reran
all 12 sandbox tests after that final change; all passed. The complete suite had
passed 78/78 immediately before it. Root subsequently confirmed that final
lint/format, typecheck, all 78 offline tests, build/pack and the repeated
fresh-prefix install passed after this change as well.

I inspected `.workflow/verification/package.json`: a fresh temporary-prefix
installation passed version, bundled documentation and all nine scripts, exact
skill printing/installation, packaged foreground QuickJS execution, and packaged
background worker execution followed by wait. The recorded check exited zero. I
also inspected the saved current terminal transcript. These are local package
and terminal results; configured Ubuntu/macOS remote CI is not claimed to have
run. The six vendor records remain narrow, versioned evidence, not a guarantee
about every backend/model combination or future release.

## Reaffirmation after Fable's cancellation finding

Fable's independent final review subsequently found a real blocker missed in my
earlier pass: root-cancelled running and queued calls were incorrectly cached as
completed nulls. The prior approval therefore required this additional recheck.
The current fix is sound: runtime journals cancelled outcomes for inspection,
but `Replay.call` writes no live completion after the root aborts. Resume keeps
the completed prefix and executes the interrupted suffix. Intentional per-agent
skips remain cacheable user choices. Historical cache hits still represent
previously completed work and need not be discarded on cancellation.

I independently inspected the updated replay/runtime wiring and ran the current
replay, run, sandbox and CLI suites: **44/44 passed**. The regression completes
a seed, stops two running and one queued calls, then proves unchanged resume
caches only the seed and runs all three interrupted calls live. It separately
proves intentional skip remains cached. Existing delivery-order and persistence
fault regressions remain green.

The additional UX changes also pass review. Guest errors report a concise
message and workflow location. EPIPE aborts owned foreground work through the
normal lifecycle rather than exiting around cleanup; the CLI regression verifies
a quiet exit, cancelled report and closed control endpoint. A broken pipe while
waiting stops observation without cancelling the background run. The skill and
DECISIONS now explicitly distinguish root cancellation, intentional skip and
cached ordinary terminal failures.

**All four conclusions are reaffirmed: full scope completed—yes; code high
quality—yes; UX high quality—yes; guidance correctly followed—yes.** No
remaining blocking finding was identified in this follow-up. Earlier
local-versus-remote and versioned-backend evidence limits still apply.

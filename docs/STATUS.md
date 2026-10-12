# Completion tracking

The initial VISION implementation and its original review evidence are recorded
below. Those completion reviews did not adequately assess source readability;
the later readability cleanup has its own changes, validation and reviews.

| Requirement                   | Implementation and evidence                                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toolchain, package, CI        | Pinned mise/pnpm/Node, strict TypeScript, lint/format, build and package; Ubuntu/macOS CI configured, not run remotely.                                                                                   |
| Script contract and isolation | Plain JavaScript, pure-literal metadata, QuickJS WASM, finite JSON bridge, clock/random bans, memory/instruction limits; hostile-input tests.                                                             |
| Core orchestration            | Agent, barrier-free pipeline, parallel, phases, logs, args, deferred budget; caps, shared concurrency and cancellation tested.                                                                            |
| Resume                        | Started-call and delivery trace, longest unchanged prefix, delivery-order replay, edited suffix, cached transcript lineage; reversed completion and microtask regressions.                                |
| Children                      | One nesting level, shared limits, static object/string preflight, stable name resolution, dynamic generated children, hashed snapshots and missing-source recovery.                                       |
| Structured output             | Original draft-07 schema validation, explicit native fallback, bounded corrections; ACP retains session, CLI uses read-only formatting turns without repeating the task.                                  |
| Drivers                       | Claude/Codex/Cursor CLI and OpenCode/Kimi/Qwen native ACP; all six have real smoke evidence and sanitized parser fixtures. Model-dependent settings refreshed and verified.                               |
| Worktrees                     | Locked HEAD branches, opt-in shared copy/symlink paths, ignored-content baseline, preserved changes/commits/setup failures, structured artifact records.                                                  |
| Process ownership             | Independent supervisor and private IPC; owner death, forced startup kill, TERM-ignoring descendants and bounded pipe drain covered. Uncertain cleanup fails the run and preserves worktrees.              |
| Persistence and controls      | Private journals/transcripts/reports, active snapshots, fatal persistence handling, authenticated live control, background readiness, stop/skip/wait and stale-run observation.                           |
| Output and UX                 | Coalesced progress tree, phase/activity/time/tool counts, NDJSON, compact completion and inspection, UTF-8-safe result spill, cached usage accounting; real pseudo-terminal exercise with offline agents. |
| Guidance                      | Bundled skill, README, decisions and eight runnable recipes; recipes execute in the real sandbox with controlled outputs for failed votes, ties, deduplication and convergence.                           |
| Override surfaces             | Documented sandbox, transport, schema strategy and shared worktree paths. Unsupported policies fail explicitly.                                                                                           |

## Initial implementation validation on 2026-09-05

- Pre-cleanup offline suite: **81 passed**. No vendor subscriptions were used by
  tests.
- Local lint/format, TypeScript checks and build passed. Fresh temporary-prefix
  npm installation, bundled docs/examples, skill print and installation,
  foreground QuickJS execution, and background worker/wait all passed. Evidence:
  `.workflow/verification/package.json`. Remote CI has not been observed.
- Built CLI exercised through a 100×24 pseudo-terminal with two independent
  find/verify pipelines. Fast-item verification began before slow-item finding
  finished. Progress showed phases, activity, tool counts and frozen completed
  times; narrator and final report were visible. Local capture:
  `.workflow/verification/terminal.ansi` and `terminal.txt`.
- [Backend verification](BACKEND-VERIFICATION.md) records six narrow real
  probes, exact models, observed capabilities and limitations. Claude's earlier
  live run `wf_184c85f2d3b1` also resumed as a full cache hit in
  `wf_3577c4bf49bb` with zero new tokens.
- [Reference consultations](REFERENCE.md) record the required Claude Opus 5
  reference questions and answers.

## Adversarial review

Initial findings were addressed with focused regressions. Earlier review
sections are historical; final follow-ups explicitly supersede withheld or
conditional verdicts.

- [Astra whole-project review](reviews/astra-completion.md): all four criteria
  approved, then reaffirmed after the final cancellation/CLI changes.
  Independent full suite: 78/78 at the prior build; final targeted recheck:
  44/44.
- [Claude Fable 5.1 whole-project review](reviews/fable-completion.md): all four
  criteria affirmatively approved after independent reproduction of stop/resume,
  per-agent skip/error caching, unawaited work cancellation, guest diagnostics
  and EPIPE cleanup. Independent final suite: 81/81; typecheck, lint and build
  clean.
- Final review-document formatting was applied after those reports were
  appended; `mise run check` is clean. The package includes the final review
  records.

The final local build and install checks are complete. Remote CI is configured
but has not been run. The explicitly deferred budget, harness agentType registry
and MCP passthrough remain documented design choices, as required by VISION.md.

## Readability cleanup on 2026-09-05

- Separated root coordination from live leaf ownership in `AgentExecution`, and
  named child preparation and pending-task tracking.
- Replaced embedded guest/supervisor strings with directly editable source
  assets; the build syntax-checks and copies them into the package.
- Separated progress, report preparation/rendering, and installation info. Named
  ACP configuration and vendor event handlers expose ordering and parsing.
- Expanded control flow and examples, named judge-panel stages, clarified replay
  identities, and added lint/format guardrails. The example formatter preserves
  multiline literal data and is checked for idempotence.
- Added the [maintenance guide](MAINTENANCE.md) with ownership boundaries,
  cancellation/replay invariants, asset handling and relevant tests.
- Local validation: **84/84 offline tests passed**, including the added
  formatter and CLI info regressions; typecheck, lint/format and package build
  passed. Fresh temporary-prefix installation exercised the bundled docs, nine
  scripts, skill print/install, foreground and background QuickJS execution, and
  an installed fixture agent. Packaged guest/supervisor files match source
  bytes. The built CLI also passed the offline 100×24 terminal progress
  exercise. Captures remain in `.workflow/verification/`.
- [Astra readability review](reviews/astra-readability.md): explicitly approved
  readability and maintainability with no blockers; independently ran 83 tests
  before the final CLI info regression was added. Approval was reaffirmed after
  50 targeted follow-up tests and a final 13-test sandbox recheck.
- [Claude Fable 5.1 readability review](reviews/fable-readability.md):
  independently approved both criteria and ran 84 tests. Nonblocking findings
  were addressed and approval reaffirmed after 66 targeted tests.

The validation above is local evidence; no remote CI result is claimed for these
changes.

## Structure and spacing pass on 2026-09-05

The first readability checkpoint was committed and pushed as `6f744e0`. A new
independent audit found that its spacing and method composition still needed
work. This pass separates class members, declarations, logical method paragraphs
and example stages, and puts public lifecycle methods before private helpers.

`GuestSession` now owns VM handles and the job pump explicitly. Protocol
routing, backend argument construction, CLI input preparation, process stream
framing, exit observation, file hashing and child archive operations have named
boundaries. Rendering uses named text parts instead of dense conditional
templates. Shared errno checks and comments expose important ownership and
ordering rules.

An AST decision count guided the structural review. It counts each function
independently (excluding nested functions): one plus branches, loops, catches,
conditional expressions and logical/nullish operators. It is a review aid, not a
complexity gate; schema validation and cleanup keep real dependencies together.

| Function                   | Checkpoint | This pass |
| -------------------------- | ---------: | --------: |
| Static call visitor        |         36 |        11 |
| CLI argument dispatcher    |         24 |         4 |
| ACP line router            |         14 |         4 |
| Claude/Cursor event router |         24 |        12 |

The full offline suite passed 84/84 after the structural changes; local
typecheck, lint/format, build, fresh installed-package execution and terminal
checks passed. Final review follow-ups and their validation are recorded
separately below.

The pushed checkpoint's macOS CI test expected two simultaneous agents while
using a CPU-derived default that can be one. The test now simulates a one-agent
configuration and explicitly requests two workers. Its startup wait also uses a
bounded deadline and reports the last observed states on failure. Later CI
results are tracked in GitHub Actions.

- [Astra structure review](reviews/astra-structure.md): all four criteria
  approved after comment and method-order corrections; independent 84-test full
  run and 10-test CLI follow-up passed.
- [Fable structure review](reviews/fable-structure.md): all four criteria
  approved after bounded rechecks of the same corrections; project check and
  typecheck passed.

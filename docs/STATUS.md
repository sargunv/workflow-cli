# Completion tracking

The VISION scope is implemented. Astra and Claude Fable 5.1 independently
approve full scope completion, code quality, UX quality, and adherence to the
vision’s authoring and design guidance. Both rechecked the final fixes before
issuing their affirmative verdicts.

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

## Validation on 2026-09-05

- Full offline suite: **81 passed**. No vendor subscriptions were used by tests.
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

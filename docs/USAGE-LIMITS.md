# Backend usage limits

Investigation for [issue #7](https://github.com/sargunv/workflow-cli/issues/7),
2026-10-12. Evidence: official documentation, upstream source snapshots and
static inspection of installed bundles. No agents were invoked or limits
exercised. Quota fixtures are synthetic, source-derived examples, not
exhausted-account recordings. Upstream snapshots may be newer than the releases
in `BACKENDS.md`.

## Workflow policy

A confirmed Claude/Codex subscription refusal uses the root cancellation path:
admission closes, owned processes terminate and join, queued agents never start,
and changed worktrees remain available. The report is `cancelled` (foreground
exit 130), with `usageLimit` recording backend, agent ID, vendor message and
available limit/reset fields. Human output includes these details and a resume
hint.

Interrupted leaves retain diagnostic records in `journal.jsonl` but no `finish`
in `replay.jsonl`. Their null outcomes never reach the script or stay cached.
Ordinary failures, intentional skips and local turn/budget ceilings retain their
cache behavior. Infrastructure failures still fail a quota-interrupted run.
There is no automatic reset wait, retry, paid-usage enablement or model switch.
Harness-owned fallback/retry can occur before a terminal refusal reaches
Workflow.

Resume retains the unchanged-prefix contract: matching completed calls replay
until the first unfinished/changed invocation, then the suffix executes live.
Completed concurrent calls admitted beyond that point can run again. Reusing
arbitrary later completions needs a separate replay design that preserves
observable delivery order and control flow. Old cached quota errors are not
migrated.

Leaf-session restoration is deferred. Claude uses `--no-session-persistence` and
Codex uses `--ephemeral`; changing this requires session ownership and retained
IDs. ACP sessions also are not reloaded across root resumes. Inspect preserved
work before resuming an editing assignment: external edits are not
transactional.

## Claude CLI

The [headless docs](https://code.claude.com/docs/en/headless) describe stream
JSON. Static inspection of installed **2.1.296** (embedded JavaScript from
`~/.local/share/claude/versions/2.1.296`, read with `strings`) found:

- `rate_limit_event.rate_limit_info` carries `allowed`, `allowed_warning` or
  `rejected`, with optional `rateLimitType`, Unix-seconds `resetsAt`, and
  overage/grace/fallback fields. Limit state alone does not prove task failure.
- Harness-generated assistant errors can carry `is_api_error_message: true`,
  `api_error: "usage_limit_reached"`, and `api_error_params.rate_limit_info`.
  The embedded schema distinguishes this refusal from transient throttling,
  entitlement/policy gates and API-key/provider 429s.
- A `result` with `subtype: "success"` can still have `is_error: true` and
  `api_error`. Other error subtypes use an `errors` array instead of result
  text.

Workflow classifies only failed terminal results, using the typed refusal or
anchored legacy limit wording when no typed kind exists. Refusal metadata wins
over advisory state. Epoch resets become UTC ISO strings; free-text resets stay
in the message. Successful results and unrelated typed errors do not interrupt.
The [API rate-limit docs](https://platform.claude.com/docs/en/api/rate-limits)
also distinguish transient throttles from spend caps; HTTP 429 alone is
inadequate.

## Codex CLI

[Official non-interactive docs](https://learn.chatgpt.com/docs/non-interactive-mode)
define `error`/`turn.failed` JSONL events.
[Pricing docs](https://learn.chatgpt.com/docs/pricing) note that active turns
may continue after an allowance is reached, subject to fair use; a quota warning
is not a reason to reject successful work.

At upstream **6e5f665**, the
[usage-limit error formatter](https://github.com/openai/codex/blob/6e5f665feb9b71e1500a5721036fbdb8e871f4b0/codex-rs/protocol/src/error.rs)
provides an account refusal with optional retry time. The
[exec event types](https://github.com/openai/codex/blob/6e5f665feb9b71e1500a5721036fbdb8e871f4b0/codex-rs/exec/src/exec_events.rs)
and
[JSONL processor](https://github.com/openai/codex/blob/6e5f665feb9b71e1500a5721036fbdb8e871f4b0/codex-rs/exec/src/event_processor_with_jsonl_output.rs)
retain its message but drop the typed code and epoch reset.

Workflow recognizes the anchored subscription refusal in either error event,
accepting straight/curly apostrophes. The rendered retry time stays verbatim:
inventing a timezone would reduce its reliability. Generic
429/reconnect/overload messages are not classified. New workspace
credit-depletion/spend-cap messages in this upstream snapshot use different
wording and are outside this matcher.

## Cursor CLI

[Output docs](https://cursor.com/docs/cli/reference/output-format) specify
nonzero exit, stderr and possibly no terminal result on failure. Static
inspection of installed **2026.10.01-e373342**, `9969.index.js`, confirms
separate success/failure paths. `index.js` groups free/pro usage errors with
throttling and entitlement failures for presentation. That grouping does not
isolate resettable exhaustion. No classifier is added without a specific quota
contract; arbitrary stderr matching would pause runs for unrelated failures.

## OpenCode ACP

[Billing docs](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/services/www/src/docs/content/console/billing.mdx)
describe prepaid workspace credits and separately billed external providers. At
**bcf23b6**, the
[session error adapter](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/core/src/session/to-session-error.ts)
has a provider-quota category. The
[ACP translator](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/cli/src/acp/translate.ts)
and
[error adapter](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/cli/src/acp/error.ts)
wrap provider failures and place the error name in JSON-RPC `error.data`.

Workflow currently discards ACP error data. Future recognition should retain
that envelope and verify the supported release's mapping. This source snapshot
is newer than the recorded 1.18.28 verification; no new classifier is claimed
for it.

## Kimi ACP

The
[FAQ](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/docs/en/faq.md)
describes quota/membership inspection, while
[print-mode docs](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/docs/en/customization/print-mode.md)
distinguish permanent quota exhaustion from retryable throttles through exit
codes. Workflow uses ACP, so those print-mode codes are not its contract.

At **9ab1286**,
[KimiSoul](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/soul/kimisoul.py)
retries provider 429s with bounded per-step attempts. The
[ACP session](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/acp/session.py)
then wraps provider failures as internal errors with the exception string in
`error.data.error`. Workflow loses that detail. No classifier is added without a
provider-specific quota distinction.

## Qwen ACP

[Authentication docs](https://github.com/QwenLM/qwen-code/blob/e397445a1e0165c769ffd7cccba45d5489d094e1/docs/users/configuration/auth.md)
describe provider-dependent quotas. At **e397445**, the
[quota detector](https://github.com/QwenLM/qwen-code/blob/e397445a1e0165c769ffd7cccba45d5489d094e1/packages/core/src/utils/quotaErrorDetection.ts)
distinguishes Qwen daily exhaustion from exhausted allocations with a reset
time.
[Retry handling](https://github.com/QwenLM/qwen-code/blob/e397445a1e0165c769ffd7cccba45d5489d094e1/packages/core/src/utils/retry.ts)
fast-fails recognized exhaustion; optional persistent retry targets transient
capacity failures.

However, the
[ACP session](https://github.com/QwenLM/qwen-code/blob/e397445a1e0165c769ffd7cccba45d5489d094e1/packages/cli/src/acp-integration/session/Session.ts)
can replace provider 429s with a generic rate-limit RPC error, losing
quota/reset detail. No classifier is added: treating that generic error as
subscription exhaustion would conflate it with transient limits.

## Offline validation

Parser tests cover both supported shapes, errors arrays, legacy wording, typed
precedence, advisory events, successful limit-related text, tool output and
generic throttles. Runtime tests cover admission, active/queued cancellation,
preserved work, resume, correction cleanup, script inability to catch a quota
null, and infrastructure-failure precedence. The CLI test uses a synthetic
process that emits a refusal and remains alive, proving Workflow terminates it
and resumes after simulated restoration.

# Fable driver and schema implementation review

Model: claude-fable-5-1; 2026-09-05. Bounded review of current implementation.

## Review verdict

**Not approved yet for this bounded scope.** The offline suite passes (68 tests)
and the core contracts hold: corrections never resend the task, ACP sessions are
retained for corrections, requested tool restrictions fail closed, the original
schema is validated without coercion, and the preamble carries the return-value
and authority boundary. Four findings below are real enough that I would not
sign off until they are fixed. The rest are low.

## Findings

**1. Cursor's final text concatenates every assistant message, so prompted
schema fails on the first attempt whenever the model narrates. Confirmed.**
`src/drivers/events.ts:93` takes `result.result`. The repo's own recorded Cursor
probe (`test/fixtures/cursor-success.jsonl`) has `result.result` equal to the
narration line plus the JSON. I ran that fixture through the parser and then
`parseStructured` at `src/runtime/schema.ts:80`; it throws on the leading
"Reading th...". Every Cursor schema agent that says anything before its answer
burns a correction turn. `test/events.test.ts:92` masks this by asserting only
that the text contains `"code":`. Fix: for Cursor, keep the text of the last
`assistant` message that follows the last `tool_call`, and fall back to
`result.result` only when no assistant text was seen. Verify against the
retained raw Cursor probe transcript that `assistant` events are whole messages
rather than deltas (BACKENDS.md lists only `thinking` as deltas). Tighten the
test to assert `parseStructured(result.text)` yields `{code: 731}`.

**2. Claude advertises `minimal` unconditionally even though `--bare` disables
OAuth and keychain auth. Confirmed by the repo's own evidence.**
`src/drivers/cli.ts:148` sets `minimal: true` for Claude and `:61` maps it to
`--bare`. `docs/BACKEND-VERIFICATION.md` states `--bare` requires an API key or
explicit helper. The recorded init event on this machine reports `apiKeySource:
"none"`. So `minimal: true` passes preflight and every such leaf fails at run
time with an auth error and a null result. That violates "refuse early" and
"info reports what the backend can actually do". Fix: in `detect()`, set
`minimal` only when `ANTHROPIC_API_KEY` or an api-key helper is configured, or
keep it true but add a detection note stating the API-key requirement and have
`liveAgent` reject `minimal` when the key is absent. Record whichever rule you
choose in DECISIONS.md.

**3. Profile-selected backends skip preflight, and concurrent `detect()` calls
each run discovery. Confirmed.** `src/runtime/run.ts:219` preflights only the
run default plus literal `backend:` keys collected by `src/runtime/script.ts`. A
profile such as `reviewer: {backend: 'codex'}` is statically visible from config
but never checked, so a missing Codex surfaces as N null leaves instead of a
launch error. DECISIONS.md claims statically visible selections are checked
before agent work. Separately, `src/drivers/cli.ts:134` and
`src/drivers/acp.ts:189` cache only the finished detection. When 16 parallel
leaves first hit an unpreflighted backend, each spawns its own `--version` plus
`codex debug models` or a full ACP session. For ACP that means up to 16 vendor
sessions created purely for discovery. Fix: include the backend of every profile
referenced by a literal `profile:` option (or simply every configured profile)
in preflight. Memoize the in-flight detection promise so concurrent callers
await one discovery.

**4. Qwen model discovery discards `models.availableModels` when a `model`
config option exists without `options`. Plausible.** `src/drivers/acp.ts:154`
picks the `model` config option first and reads `config.options`. The recorded
Qwen surface in `test/fixtures/qwen-model-config.json` has a `model` entry with
`currentValue` and no `options`. BACKENDS.md says Qwen reports models under a
separate `models` object. Replaying the recorded surface through the same logic
yields zero entries. Consequences: `info` lists no Qwen models, no default
marker, and the effort loop has no default model to attach `reasoning_effort`
choices to, so Qwen's effort levels never appear in `info` despite the driver
refreshing them. Fix: fall back to `session.models.availableModels` when the
config option has no entries, and attach effort choices to the current model ID
even when the catalog is empty. Add an offline assertion on `detect()` output
using this fixture.

**5. Low: journal fabricates `cost: 0` for backends that report no cost.**
`src/runtime/run.ts:649` always writes a numeric cost. Codex, Cursor, and
OpenCode without cost data then show 0 instead of "unreported", contradicting
the skill's promise that missing usage is explicitly marked. Fix: set `cost`
only when at least one attempt reported it.

**6. Low: `input` tokens are not comparable across backends.**
`src/drivers/events.ts:32` reads Claude's `input_tokens`, which excludes cache
creation and cache read. The real run recorded input 10 against 17,680
cache-creation tokens. Codex's `input_tokens` includes cached tokens. The report
sums these as one number. Either normalize (Claude: input plus cache_creation
plus cache_read) or label the column as vendor-defined.

**7. Low, unverified: a correction turn on Claude can pass `--tools ""`.**
`src/runtime/run.ts:607` intersects the caller's allow list with Read/Grep/Glob.
An allow list such as `['Bash']` becomes empty and `cliArguments` emits `--tools
""`. Whether Claude retains `StructuredOutput` under an empty tool list is
unprobed. Safer: use the `read-only` policy for every correction turn, since the
deny list still applies and read tools cannot cause side effects.

**8. Low: Cursor tool labels are noise.** `src/drivers/events.ts:89` joins every
key of `tool_call`, producing "readToolCall, hookAdditionalContexts, toolCallId,
startedAtMs" in progress and transcripts. Pick the key ending in `ToolCall`.

**9. Low: `session/set_model` result is never verified.**
`src/drivers/acp.ts:312` ignores the response, unlike the config-option path
that checks the reported active value. Re-read the session configuration or
`currentModelId` after the call and fail if it differs.

**10. Low: recorded-evidence documents are stale relative to the code.**
`docs/STATUS.md` rows for CLI and ACP drivers still say "first recorded Claude
fixture" and "live verification pending", and remaining-work item 1 describes
correction work that is implemented. `test/fixtures/README.md` says other
backend fixtures still need live probes and gives no provenance for the Codex,
Cursor, ACP, or Qwen-config fixtures, while BACKEND-VERIFICATION says they were
sanitized from real probes. There is also no fixture for `cursor-agent models`
output, so the regex in `src/drivers/cli.ts` for Cursor model discovery has no
recorded evidence.

## What passed

- Claude CLI flags, read-only allowlist with native schema, and `Agent,Workflow`
  exclusion match the recorded init event and journal.
- Codex strict-mode gating keeps the caller's schema; incompatible schemas fall
  back to prompted output with a warning.
- Turn-mode corrections omit the task and profile append, carry the prior output
  verbatim, and force read-only or plan mode. Session-mode corrections reuse one
  ACP session, warn on tool use, and close on every exit path including
  ownership errors.
- Native results are validated locally against the original schema. Null results
  always carry a reason and a transcript record.
- ACP permission callback, config refresh after model selection,
  unapplied-effort warning, and context-occupancy exclusion from usage are all
  covered offline with the recorded Qwen surface.
- The leaf context matches the VISION contract: prompt only, preamble with
  return contract and authority boundary, cwd or worktree paragraph, no phase,
  label, index, or sibling data.

Fix items 1 through 4 and I would approve this scope. Items 5 through 10 can
ride along or be recorded as known limitations.

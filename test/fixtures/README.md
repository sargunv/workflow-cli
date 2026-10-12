# Recorded protocol fixtures

`claude-usage-limit.jsonl` and `codex-usage-limit.jsonl` are **synthetic,
source-derived** quota fixtures, not live recordings. Their provenance and
recognition boundaries are documented in [the usage-limit investigation](../../docs/USAGE-LIMITS.md).
No subscription was exhausted to produce them. The Claude example models the
2.1.296 typed refusal and Unix-seconds reset metadata; the Codex example models
exec's message-only `error`/`turn.failed` stream. Dates, IDs and counters are
invented test data.

`claude-success.jsonl` is derived from a real Claude CLI 2.1.261 session using
`claude-haiku-4-5-20251001` on 2026-09-05, run `wf_184c85f2d3b1`. It retains
assistant text/tool-use blocks and terminal result/usage fields. Unrelated
session identifiers, local paths, and hook metadata were removed. The source
run is local under `.workflow/runs/` and is not committed.

`claude-read-only-schema.jsonl` records run `wf_b8189b9e3559` on the same
CLI/model/date, using `toolPolicy: 'read-only'` and native schema output. The
init event confirms exactly Glob, Grep, Read and StructuredOutput were exposed.
It returned `{ok:true}` with 112 reported output tokens. The local original is
under `.workflow/probes/`; identifiers, paths and hook metadata were removed.

`codex-models.json` contains only model IDs, visibility, priority and reasoning
fields from `codex debug models` 0.153.3 on 2026-09-05. No agent was invoked.
Catalog prompts and unrelated fields were removed.

The executable helpers under `test/helpers/` are synthetic offline servers.
The ACP helper tests protocol handling and retained sessions; it is not evidence
that any installed vendor accepts the same operations.

`codex-success.jsonl`, `cursor-success.jsonl`, `acp-opencode.jsonl`,
`acp-kimi.jsonl` and `acp-qwen.jsonl` are sanitized from the single successful
benign-file probes recorded in `docs/BACKEND-VERIFICATION.md` on 2026-09-05.
ACP records retain both turns. `qwen-model-config.json` preserves the configuration
surfaces before and after selecting Flash, including its changed effort options;
the synthetic ACP helper replays these surfaces for the selection regression.
Unrelated IDs, paths, thought chunks, hooks and provider catalogs were removed.
Tests must never obtain fixtures by invoking a real agent automatically.

`cursor-models.txt` is the literal `cursor-agent models` catalog from the same
2026-09-05 discovery, without prompts or session data. `qwen-session-config.json`
retains `models` and `configOptions` from the recorded Qwen session/new response;
it covers the separate model catalog when the model config has no options.

# Recorded protocol fixtures

Fixtures are sanitized: session IDs, local paths, hook metadata, thought chunks
and unrelated catalog fields are removed, and catalogs keep only the entries
tests assert on. Tests must never obtain fixtures by invoking a real agent.

- `claude-success.jsonl`: Claude CLI 2.1.261 session, 2026-09-05.
- `claude-usage-limit.jsonl`: synthetic, from Claude CLI 2.1.296 embedded
  schemas; dates and IDs are invented.
- `codex-success.jsonl`: Codex CLI 0.153.3 session, 2026-09-05.
- `codex-models.json`: `codex debug models` from Codex CLI 0.153.3, 2026-09-05.
- `codex-usage-limit.jsonl`: synthetic, from Codex exec source; dates and IDs
  are invented.
- `cursor-success.jsonl`: Cursor CLI 2026.09.02 session, 2026-09-05.
- `cursor-models.txt`: `cursor-agent models` from Cursor CLI 2026.09.02,
  2026-09-05.
- `grok-success.jsonl`: Grok CLI 1.0.62 session with a JSON schema and the
  read-only tool list, 2026-10-21.
- `grok-models.txt`: `grok models` from Grok CLI 1.0.62, trimmed, 2026-10-21.
- `acp-opencode.jsonl`, `acp-kimi.jsonl`, `acp-qwen.jsonl`: ACP sessions with
  both turns, 2026-09-05.
- `qwen-model-config.json`: Qwen ACP config surfaces before and after selecting
  Flash, 2026-09-05.
- `qwen-session-config.json`: `models` from a Qwen ACP `session/new` response,
  2026-09-05.

The executables under `test/helpers/` are synthetic servers; they test protocol
handling, not what any installed vendor accepts.

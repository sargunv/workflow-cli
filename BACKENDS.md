# Backend CLI usage patterns

The separate [usage-limit investigation](docs/USAGE-LIMITS.md), dated 2026-10-12,
uses documentation and static source/bundle inspection without quota probes.
The live observations below remain tied to their original versions and date.

Findings from probing the agent CLIs installed on this machine on 2026-09-05. Every claim below was either read from `--help` output or observed by running the command. Versions:

| Backend | Binary | Version |
| --- | --- | --- |
| claude | `claude` | 2.1.261 |
| codex | `codex` | 0.153.3 |
| opencode | `opencode` | 1.18.28 |
| kimi | `kimi` | 0.41.0 |
| cursor | `cursor-agent` (alias `agent`) | 2026.09.02 |
| qwen | `qwen` | 0.23.0 |

Not installed: gemini, aider, amp, copilot, droid, goose, crush.

## Capability matrix

| | claude | codex | opencode | kimi | cursor | qwen |
| --- | --- | --- | --- | --- | --- | --- |
| Headless invocation | `claude -p` | `codex exec` | `opencode run` | `kimi -p` | `cursor-agent -p` | `qwen <prompt>` |
| JSON event stream | `--output-format stream-json --verbose` | `--json` | `--format json` | `--output-format stream-json` | `--output-format stream-json` | `-o stream-json` |
| Single JSON result | `--output-format json` | `-o <file>` for last message | no | no | `--output-format json` | `-o json` (array of events) |
| Final text location | `result.result` | last `item.completed` with `type: agent_message` | last `text` part before `step_finish` with `reason: stop` | last `{"role":"assistant","content":...}` line | `result.result` | `result.result` |
| Structured output | `--json-schema <json>` (native, tool-forced) | `--output-schema <file>` (native, strict) | prompted | prompted | prompted | `--json-schema <json or @file>` (native, tool-forced) |
| Model flag | `--model` | `-m` | `-m provider/model` | `-m alias` | `--model` | `-m` |
| Model discovery | none (aliases: fable, opus, sonnet, haiku) | `codex debug models` (JSON catalog with efforts) | `opencode models [--verbose]` (JSON per model) | `~/.kimi-code/config.toml` `[models.*]` | `cursor-agent models` | none |
| Effort | `--effort low..max` | `-c model_reasoning_effort=<level>` | `--variant <level>` (provider-specific) | config only (`[thinking].effort`) | baked into model id (`claude-opus-5-low`) | none |
| Skip approvals | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--auto` | config `default_permission_mode = "yolo"` | `--yolo` (alias `--force`) + `--trust` | `-y` / `--approval-mode yolo` |
| Read-only policy | `--tools`, `--disallowedTools`, `--restricted` | `-s read-only` (sandbox enforced) | none | none | `--mode plan` or `--mode ask` | `--approval-mode plan`, `--exclude-tools` |
| System prompt append | `--append-system-prompt` | none | none | `--agent-file <md>` | none | `--append-system-prompt` |
| Working directory | process cwd, `--add-dir` | `-C <dir>` | `--dir <dir>` | process cwd | `--workspace <dir>` | process cwd |
| No session persistence | `--no-session-persistence` | `--ephemeral` | none | none | none | `--chat-recording=false` |
| Usage in output | tokens, cost, per-model | tokens | tokens, cost | none | tokens | tokens |
| Native worktree flag | `-w` | no | no | no | `-w` | `--worktree` |
| ACP server | adapter only (`claude-code-acp`) | adapter only (`codex-acp`) | `opencode acp` | `kimi acp` | no | `qwen --acp` |
| Budget/limit flags | `--max-budget-usd` | none | none | none | none | `--max-wall-time`, `--max-tool-calls`, `--max-session-turns` |
| Prompt via stdin | yes (when `-p` and no positional) | yes (`-` or piped; piped stdin is appended as a `<stdin>` block) | no | no | no | yes (appended to `-p`) |

## Per-backend notes

### claude

Working invocation:

```
claude -p "<prompt>" \
  --output-format json \
  --dangerously-skip-permissions \
  --no-session-persistence \
  --model haiku --effort low \
  --append-system-prompt "<preamble>"
```

- `--output-format json` returns one object. The fields that matter: `result` (final text), `structured_output` (present when `--json-schema` was given, already parsed), `is_error`, `subtype`, `session_id`, `num_turns`, `usage`, `total_cost_usd`, `modelUsage` keyed by model id, `permission_denials`.
- `--output-format stream-json` needs `--verbose` or it prints nothing useful. Events: `system/init` (carries `cwd`, `tools`, `model`), `assistant` (full message objects with `thinking`, `text`, and `tool_use` blocks), `user` (tool results), `rate_limit_event`, and a final `result` object identical to the json format. Hook lifecycle events also appear as `system/hook_started` and `system/hook_response`.
- `--json-schema` takes the schema as a JSON string. Validation is enforced by forcing a tool call, and the final `result` string is the JSON text while `structured_output` is the object. The PONG probe with a schema cost two turns instead of one.
- Model accepts aliases (`fable`, `opus`, `sonnet`, `haiku`) or full ids. There is no listing command, so the driver ships a static table.
- `--permission-mode bypassPermissions` plus `--permission-prompts none` is the explicit form of skip. `--dangerously-skip-permissions` is the shorthand and worked.
- `--restricted` removes shell and code tools and refuses bypass mode. Useful for a hard read-only policy. `--tools "Read,Grep,Glob"` is the softer form.
- `--bare` skips hooks, CLAUDE.md discovery, memory, and plugins. Probably not what we want for leaf agents since project CLAUDE.md is valuable context, but it is the right choice for a speed-sensitive mechanical stage.
- Session start hooks from the user's config ran during the probe. Any driver output parser must ignore hook events.

### codex

Working invocation:

```
codex exec --json \
  --skip-git-repo-check --ephemeral \
  -C <dir> \
  -s read-only \
  -m gpt-6-astra -c model_reasoning_effort=low \
  --output-schema <schema-file> -o <last-message-file> \
  "<prompt>"
```

- `codex exec` is non-interactive by default. The top-level `-a never` flag does not exist on `exec` and errors. Approval is already never in exec mode; the sandbox flag is what controls damage.
- `--json` emits JSONL: `thread.started`, `turn.started`, `item.started` and `item.completed` (item types seen: `command_execution` with `command`, `aggregated_output`, `exit_code`; `agent_message` with `text`), `turn.completed` with `usage`, and on failure `error` plus `turn.failed`. There is no cost field.
- `-o <file>` writes only the final agent message, which is the simplest way to get the return value. Without `--json`, stdout is a human-readable header (model, provider, approval, sandbox, reasoning effort, session id) followed by transcript text.
- `--output-schema` uses OpenAI strict mode. The schema must have `additionalProperties: false` at every object level or the API rejects it with `invalid_json_schema`. Strict mode also requires every property to be listed in `required`. The driver must normalize schemas before sending them. When accepted, the final message text is the JSON and `-o` writes it verbatim.
- `codex debug models` prints a JSON catalog. Each entry has `slug`, `display_name`, `supported_reasoning_levels` (a list of `{effort, description}`), `default_reasoning_level`, and `visibility` (`list` or `hide`). Effort levels seen: low, medium, high, xhigh, max, and ultra on some models. This is the best model discovery of any backend.
- Effort is set via `-c model_reasoning_effort=<level>`. The header confirmed `reasoning effort: xhigh` when passed.
- `-s read-only` is a real sandbox, not a prompt. `--dangerously-bypass-approvals-and-sandbox` is required for write access outside the workspace-write sandbox. The user's config already sets `sandbox_mode = "danger-full-access"` and `approval_policy = "never"`; the driver should pass flags explicitly rather than rely on that.
- stdin is always read. It printed "Reading additional input from stdin..." on stderr even with stdin from /dev/null. Always redirect stdin or pass the prompt through it deliberately.
- `--skip-git-repo-check` is needed for any cwd that is not a git repo.

### opencode

Working invocation:

```
opencode run --format json --dir <dir> --auto -m <provider/model> --variant high "<prompt>"
```

- `--format json` emits JSONL events: `step_start`, `text` (with `part.text`), `tool_use` (with `part.tool`, `part.callID`, `part.state.status`, `part.state.input`, `part.state.output`), and `step_finish` with `part.reason` (`tool-calls` or `stop`), `part.tokens` (`input`, `output`, `reasoning`, `cache.read`, `cache.write`), and `part.cost`. There is no terminal result event; the driver takes the text parts of the last step whose `step_finish.reason` is `stop`.
- No event names the model in use. The driver must record what it asked for.
- No structured output flag. Prompted strategy only.
- `opencode models` lists every model across configured providers as `provider/model`, 87 on this machine. `--verbose` adds a JSON block per model with `cost`, `limit` (context, input, output), `capabilities`, and `status`. `opencode models <provider>` filters. `--refresh` updates the cache from models.dev.
- `--variant` is the effort knob and is provider-specific (examples in help: high, max, minimal). No validation of what a given model accepts, so `info` should not promise levels for opencode.
- `--auto` auto-approves anything not explicitly denied. The user's config also has `"permission": "allow"`. No read-only mode from the CLI; opencode agents defined in config can carry permission rules, and `--agent <name>` selects one, which is the only route to a tool policy.
- No system prompt flag. Same `--agent` route or prompt prepend.
- No way to disable session persistence.

### kimi

Working invocation:

```
kimi -p "<prompt>" --output-format stream-json -m kimi-code/k3
```

- `-p` cannot be combined with `--auto` or `--yolo`. Both error. Headless permission mode comes from `default_permission_mode` in `~/.kimi-code/config.toml`, which is `yolo` on this machine. The tool probe ran a shell command without prompting. The driver should verify this setting at `detect()` time and refuse to run kimi if it is not yolo, since there is no flag to override.
- `--output-format stream-json` lines are minimal: `{"role":"meta","type":"system.version"}`, `{"role":"assistant","content":"..."}`, `{"role":"assistant","tool_calls":[...]}` in OpenAI function-call shape, `{"role":"tool","tool_call_id":...,"content":...}`, and a final `{"role":"meta","type":"session.resume_hint"}`. The final text is the last assistant line with `content`.
- Raw tool stdout is interleaved with the JSON lines on stdout. The `echo hi-from-tool` probe produced a bare `hi-from-tool` line between JSON records. The parser must skip lines that do not parse as JSON.
- Text mode (`--output-format text`, the default) prints bullet-prefixed lines and duplicates output to stderr along with a resume hint. Use stream-json.
- No usage or cost reporting in either format.
- No structured output flag. Prompted strategy only.
- Models are aliases defined in config under `[models."<alias>"]` with `provider`, `model`, `max_context_size`, `capabilities`, and optionally `support_efforts` and `default_effort`. `kimi provider list` shows providers and model counts and the default model. Discovery means parsing the TOML.
- Effort is `[thinking].effort` in config with no CLI override. Per-run effort would need a temporary config, which the CLI does not appear to support via flag either. Treat as unsupported.
- `--agent-file <path>` loads a Markdown agent definition, which is the route to a custom system prompt. The driver could write one per run.
- `--add-dir` exists. No `--dir`; cwd is the process cwd.

### cursor

Working invocation:

```
cursor-agent -p --output-format json --yolo --trust --workspace <dir> --model <id> "<prompt>"
```

- `--output-format json` returns one object: `type: result`, `subtype`, `is_error`, `result` (final text), `session_id`, `request_id`, `duration_ms`, `usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`). No cost.
- `stream-json` events: `system/init` (with `cwd`, `session_id`, `model` display name, `permissionMode`), `user`, `thinking` deltas, `assistant` messages, `tool_call` with `subtype` started/completed and a `tool_call` object keyed by tool kind (`shellToolCall` with `args.command` and results), and a final `result`. The `call_id` values contain an embedded newline.
- `system/init` reported `permissionMode: "default"` even with `--yolo`, yet the shell tool ran without prompting. Do not trust that field.
- No structured output flag. Prompted strategy only.
- `cursor-agent models` lists ids with display names. Effort and speed are encoded in the id: `claude-opus-5-low`, `claude-opus-5-high-fast`, `gpt-5.3-codex-xhigh`. `--model` also accepts bracket overrides like `claude-opus-4-8[context=1m,effort=high,fast=false]`. The driver should map `effort` onto whichever form the chosen model supports, and `info` should list the base ids with their available suffixes.
- Default model when none is given was `Cursor Grok 4.6 High Fast` on this account (the `auto` entry).
- `--mode plan` and `--mode ask` are read-only. `--sandbox enabled` is a separate control.
- `--trust` is needed to avoid a workspace trust prompt. `--workspace` sets the directory.
- No system prompt flag. No session persistence toggle.

### qwen

Working invocation:

```
QWEN_CODE_SUPPRESS_YOLO_WARNING=1 qwen "<prompt>" -o json -y --json-schema @<schema-file>
```

- `-o json` prints a JSON array of every event; `-o stream-json` prints them as JSONL. The event shapes copy Claude Code: `system/init` (with `cwd`, `tools`, `model`, `permission_mode`, `slash_commands`), `assistant` messages with `thinking`, `text`, and `tool_use` blocks, `user` tool results, and a final `result` with `result`, `usage`, `permission_denials`, and a `stats` block broken down per model and per source.
- `--json-schema` registers a synthetic `structured_output` tool and ends the session on the first valid call. Accepts inline JSON or `@path`. The `result` string is the JSON text; there is no separate parsed field, so the driver parses it.
- `-y` prints a warning on stderr about running without a sandbox; `QWEN_CODE_SUPPRESS_YOLO_WARNING=1` silences it. `--approval-mode plan` is the read-only mode. `--allowed-tools` and `--exclude-tools` shape the tool set.
- `--append-system-prompt` and `--system-prompt` both exist.
- `--max-wall-time`, `--max-tool-calls`, and `--max-session-turns` abort with exit code 55. These are the only per-run hard limits any backend offers besides Claude's dollar budget.
- No model listing. The default was `qwen3.8-max`. No effort flag.
- The `stats.bySource` block showed a second API call from `managed-auto-memory-extractor` on the plain probe. `--bare` skips that kind of auto-discovery and is worth using for cheap stages.
- The `-p` flag is deprecated in favor of a positional prompt.

## ACP (Agent Client Protocol)

Three backends ship a native ACP server: `opencode acp`, `kimi acp`, and `qwen --acp`. ACP is JSON-RPC 2.0 over stdio with newline-delimited messages. I ran the handshake, opened a session, and sent the tool-use prompt to each. All three completed it.

What the protocol gives us, as observed:

- **Handshake.** `initialize` returns `agentCapabilities` (`loadSession`, `promptCapabilities`, `sessionCapabilities` such as `fork`, `resume`, `list`, `close`, and on kimi `additionalDirectories`), `authMethods`, and `agentInfo` with name and version. This doubles as `detect()`.
- **Session creation.** `session/new` takes `cwd` and `mcpServers` and returns a `sessionId` plus the live configuration surface. Opencode and kimi return `configOptions`: a `model` select listing every available model with the current value, and on kimi also a `thinking` select (low, high, max) and a `mode` select. Qwen returns a `models` object with `currentModelId` and `availableModels` including context limits. This is live model discovery, and for kimi it is the only per-run effort control that exists, since the CLI has no flag.
- **Prompting.** `session/prompt` with a list of content blocks. The response is `{stopReason: "end_turn", usage?}`. Opencode reports per-turn token usage in the response; qwen puts usage in `_meta` on message chunks and in `usage_update` notifications; kimi only reports context used.
- **Streaming.** `session/update` notifications with a `sessionUpdate` discriminator: `agent_thought_chunk`, `agent_message_chunk`, `tool_call` (with `toolCallId`, `title`, `kind` such as `execute`, `status`, `rawInput`, `locations`), `tool_call_update` (status transitions to `in_progress` and `completed`, `rawOutput` or `content`), `usage_update`, `available_commands_update`, and `session_info_update`. The shapes were identical across the three backends apart from `_meta` extras.
- **Final text** is the concatenation of `agent_message_chunk` text between the prompt request and its response.
- **Permissions.** ACP defines a `session/request_permission` callback the client answers. None of the three sent one because their configs already auto-approve, so auto-approval through ACP is untested here, but it is the protocol's intended mechanism and would give the runtime a uniform bypass that does not depend on per-backend flags or config files.
- **Not in ACP:** structured output, effort on backends that do not expose it as a config option, and session persistence control. Prompted structured output still applies.

Adapters exist for the other backends but are not installed here: Zed publishes `claude-code-acp` for Claude Code and `codex-acp` for Codex. Codex's own `app-server` is a different JSON-RPC protocol with generated TypeScript bindings and a JSON Schema. Cursor has no ACP surface.

Practical notes: an ACP server is a long-lived process that can host many sessions, so one process per backend with one session per agent is possible and saves startup cost, though a crash then takes every in-flight agent with it. My probe script also left the qwen server running after killing the parent, so drivers must own the process group.

## Cross-cutting driver implications

1. **Two transports, four parsers.** Over the CLI, claude, cursor, and qwen share a `system/init ... assistant ... result` shape with a `result.result` final string, codex and opencode use item or step streams with no terminal result record, and kimi is its own minimal chat-log shape. Over ACP, opencode, kimi, and qwen share one event shape, and adapters could bring claude and codex under it too. The driver interface should be transport-agnostic, with an `acp` transport that covers every ACP-speaking backend with one parser and a `cli` transport with per-backend parsers for the rest. Prefer ACP where a backend has it natively, because it also solves model discovery and kimi's effort and permission gaps.
2. **Native structured output exists on three backends** (claude, codex, qwen) and each takes the schema differently: inline JSON, a strict-mode file, or either. The runtime normalizes the schema once (add `additionalProperties: false`, fill `required`) and each driver serializes it its own way. The other three use the prompted strategy.
3. **Effort is not portable.** Five different mechanisms and one backend with none. The driver interface should take the runtime's effort word and map it to a model id suffix, a flag, a config override, or drop it with a warning that `info` predicted.
4. **Model discovery is live on four backends** (codex catalog, opencode list, kimi config file, cursor list) and static on two (claude aliases, qwen none). `info` should call the live sources and cache them.
5. **Permission bypass is a flag on five backends and a config file on one.** The kimi driver has to check config at detect time and report unavailability rather than hang at run time.
6. **Read-only is enforceable on four** (claude via tools or restricted, codex via sandbox, cursor via mode, qwen via approval mode). Opencode and kimi cannot enforce it from the CLI, and `info` must say so.
7. **Always redirect stdin.** Codex reads it unconditionally. Feed the prompt through stdin where supported to avoid argv length limits on long prompts, and use `/dev/null` otherwise.
8. **Usage is available on five backends, cost on two.** `budget` can count output tokens on everything but kimi. Dollar budgets are only meaningful on claude and opencode.
9. **Every backend loads the user's own config, hooks, and instruction files.** Session start hooks fired for claude, an auto-memory extractor ran for qwen, and codex printed hook lines. Drivers should not try to suppress this by default, since project instruction files are useful context, but the "bare" flags on claude and qwen are the right choice for mechanical stages and `info` should expose that as a per-backend `minimal` option.
10. **Session persistence is optional on three backends only.** Fan-outs of hundreds of agents will litter session stores on opencode, kimi, and cursor. Document it; do not try to clean up another tool's state.

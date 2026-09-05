# Backend verification

Observed on 2026-09-05 with the versions in BACKENDS.md: Claude 2.1.261, Codex
0.153.3, Cursor 2026.09.02, OpenCode 1.18.28, Kimi 0.41.0, Qwen 0.23.0. These
are narrow behavior probes, not guarantees about every available model. The
offline suite never invokes vendor binaries.

| Backend / model                | Probe                                                                           | Result                                                                                      | Reported output tokens |
| ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------- |
| Claude / Haiku 4.5             | Native schema with read-only tool allowlist                                     | `{ok:true}`; init exposed only Glob, Grep, Read, StructuredOutput                           | 112                    |
| Codex / gpt-5.6-luna, low      | Read a benign file using read-only sandbox and native strict schema             | `{code:731}`                                                                                | 311                    |
| Cursor / composer-2.5          | Read a benign file in plan mode                                                 | Final assistant message is `{code:731}`; terminal aggregate also contains earlier narration | 286                    |
| OpenCode / openai/gpt-5.6-luna | Read a benign file, then recall its value in the same ACP session without tools | `{code:731}`, then `{remembered:731}`                                                       | 9 + 10                 |
| Kimi / kimi-code/k3, low       | Same two-turn ACP probe                                                         | `{code:731}`, then `{remembered:731}`                                                       | Unreported             |
| Qwen / qwen3.6-flash(openai)   | Same two-turn ACP probe after selecting the model and session YOLO mode         | `{code:731}`, then `{remembered:731}`                                                       | Unreported             |

The initial Qwen probe failed before any prompt: changing from the configured
Max model to Flash changed its effort choices from low/medium/xhigh to
none/default. The driver now refreshes configuration after each selection,
verifies reported active values, and explicitly warns when an effort cannot be
applied. The subsequent corrected probe passed with that warning. Its recorded
configuration surfaces also drive an offline regression.

OpenCode and Kimi responses confirmed the requested model IDs. Kimi confirmed
thinking=low. Qwen confirmed the Flash model and mode=yolo. OpenCode exposes
reasoning controls after selecting a compatible model even when its initial
default exposes none. `info` reports ACP effort choices only for the active
default model; other models are checked after selection. Qwen's usage updates
contain context occupancy (`used`/`size`), not input/output token usage; those
values are deliberately not counted as tokens spent.

Claude's CLI help exposes five effort flag values but no per-model effort
catalog or configured-default query. Static model IDs are listed without
invented per-model levels or a default marker. Codex's catalog does not identify
the configured default either; catalog priority is not treated as that default.
Hidden Codex models and values outside the script's five-level effort API are
excluded. Cursor effort variants remain part of its literal model IDs.

Native ACP requires a session to obtain model-dependent configuration. These
discovery sessions do not send model prompts, but vendors can retain them. Kimi
and Qwen sessions explicitly select YOLO when advertised; incoming ACP
permission requests are auto-approved. The permission callback is covered by the
synthetic protocol server. The real benign reads did not establish every
possible permission/configuration combination.

ACP planning modes are visible, but equivalent enforceable read-only policies
have not been established for all tools, particularly shell and provider
extensions. The drivers therefore reject requested ACP tool policies. Qwen's
CLI-native schema and hard-limit flags are not ACP facilities; the runtime uses
prompted output and its own configured timeouts. Minimal context is unsupported
for these ACP backends. Claude's `--bare` also disables normal OAuth/keychain
authentication according to its current help; it requires an API key or an
explicit helper configuration. Workflow conservatively advertises minimal mode
only when `ANTHROPIC_API_KEY` is present; helper-only authentication is not
discovered.

## Reproduction and fixtures

`mise run probe -- --backend <name> --model <cheap-model>` makes one
deliberately small live probe and saves results and raw events in a private
temporary directory. ACP gets exactly two turns to verify session continuity. It
has no automatic retries. Use it only when a concrete behavior needs
verification; each prompt consumes real subscription quota.

The original local probe directories were:

- OpenCode:
  `/var/folders/51/7gt5zp9d58n2w8qcsmgn8vjr0000gn/T/workflow-live-opencode-WcsbHc`
- Kimi:
  `/var/folders/51/7gt5zp9d58n2w8qcsmgn8vjr0000gn/T/workflow-live-kimi-pd5c9K`
- Qwen:
  `/var/folders/51/7gt5zp9d58n2w8qcsmgn8vjr0000gn/T/workflow-live-qwen-llMMgw`
- Codex:
  `/var/folders/51/7gt5zp9d58n2w8qcsmgn8vjr0000gn/T/workflow-live-codex-dzSlPa`
- Cursor:
  `/var/folders/51/7gt5zp9d58n2w8qcsmgn8vjr0000gn/T/workflow-live-cursor-m5HC7U`
- Claude: `.workflow/probes/wf_b8189b9e3559`

Sanitized protocol records are in `test/fixtures/`. They retain return text,
tool events, usage and terminal status; unrelated IDs, paths, thought chunks,
hooks, provider catalogs and session metadata were removed. Raw local artifacts
are not part of the package.

Cursor's recorded assistant events are complete messages: the pre-tool narration
and post-tool JSON answer are separate events. The parser returns the last
assistant message after tool activity, using the aggregate terminal result only
when no such message exists. Tool labels select the actual `*ToolCall` field.
Qwen's model config omits its options; discovery falls back to the separate
`models.availableModels` catalog and attaches effort to the reported current ID.

Unknown usage remains unknown. Claude input totals include cache creation and
cache read tokens; missing cost remains absent rather than a manufactured zero.
Reported counters still depend on vendor accounting and are not monetary
estimates.

# Vision

A standalone CLI for orchestrating multi-agent workflows across any coding agent harness.

Claude Code has a "dynamic workflows" feature: the model writes a JavaScript script that fans work out to subagents, verifies results adversarially, loops until convergence, and returns structured data. It is the most useful shape of multi-agent orchestration we have seen, and it is locked inside one harness. This project lifts that shape out into a CLI that is independent of any harness and can drive **any** agent as a leaf worker: Claude Code, Codex, OpenCode, Kimi, Cursor, and whatever comes next.

The orchestration layer is deterministic code. The leaf work is model-driven. Only the leaf work should care which vendor is on the other end.

## Reference model

The design target is functional parity with the Claude Code Workflow tool as it exists today. This section records how that tool works so the parity target is concrete. Where our CLI deliberately differs, the difference is called out.

### Invocation

The tool is called with one of:

- an inline script,
- a path to a script file,
- the name of a saved workflow (looked up in `.claude/workflows/`),

plus an optional `args` value (any JSON) and an optional `resumeFromRunId`. The call returns immediately with a run ID, a transcript directory, and the path the script was persisted to. The workflow runs in the background and the caller is notified when it finishes with whatever the script returned. A `/workflows` view shows a live progress tree grouped by phase.

### Script shape

The script is **plain JavaScript**, not TypeScript. Type annotations, interfaces, and generics fail to parse. The body runs in an async context, so top-level `await` works and a top-level `return` is the workflow's result.

Every script begins with a pure-literal header:

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files, verify each finding',   // shown in the permission dialog
  whenToUse: '...',                                             // optional, shown in the workflow list
  phases: [{ title: 'Review' }, { title: 'Verify', model: 'opus' }],  // optional
}
```

"Pure literal" is enforced: no variables, calls, spreads, or template interpolation. The harness parses it statically before running anything, for the permission prompt and the progress UI.

### Sandbox

The script has no filesystem or Node API access. Standard JS built-ins are available except for `Date.now()`, `Math.random()`, and argless `new Date()`, which throw. Those are banned because resume replays the script and matches `agent()` calls by their arguments; nondeterministic inputs would break the replay.

### Injected globals

This is the entire API surface a script sees.

| Global | Signature | Semantics |
| --- | --- | --- |
| `agent` | `(prompt, opts?) => Promise<any>` | Spawn one subagent. Resolves to its final text, or to a validated object when `opts.schema` is set. Resolves to `null` if the user skipped it or it died after retries. |
| `pipeline` | `(items, ...stages) => Promise<any[]>` | Run each item through every stage independently with **no barrier** between stages. Stage callbacks receive `(prevResult, originalItem, index)`. A throwing stage nulls that item and skips its remaining stages. |
| `parallel` | `(thunks) => Promise<any[]>` | Run zero-arg functions concurrently and wait for **all** of them. Never rejects; a failed thunk becomes `null`. |
| `phase` | `(title) => void` | Set the progress group for subsequent `agent()` calls. |
| `log` | `(message) => void` | Emit a narrator line to the user. |
| `args` | `any` | The `args` input, verbatim. |
| `budget` | `{ total, spent(), remaining() }` | Output-token ceiling for the run. Once `spent()` reaches `total`, further `agent()` calls throw. |
| `workflow` | `(nameOrRef, args?) => Promise<any>` | Run another workflow inline as a child. Shares the concurrency cap, agent counter, abort signal, and budget. One level of nesting only. |

`agent()` options:

| Option | Type | Purpose |
| --- | --- | --- |
| `label` | string | Display name in the progress tree. |
| `phase` | string | Progress group. Preferred over global `phase()` inside `pipeline`/`parallel` to avoid races. |
| `schema` | JSON Schema | Force structured output. Root must be `{type: 'object', properties: {...}}` and `required ⊆ properties`. Unsatisfiable schemas throw at call time. |
| `model` | string | Model override. Default is to inherit the session model. |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | Reasoning effort override. |
| `isolation` | `'worktree'` | Run in a fresh git worktree. Auto-removed if unchanged. |
| `agentType` | string | Use a named subagent definition (system prompt plus tool allowlist) from the same registry as the interactive Agent tool. Composes with `schema`. |

Structured output is implemented by forcing the subagent to call a `StructuredOutput` tool whose input schema is the caller's schema. Validation happens at the tool-call layer, so a mismatch is an error the model sees and retries on, and the script never parses anything.

Subagents are told that their final text **is** the return value, not a message to a human, so they emit raw data instead of prose.

### Runtime limits and guarantees

- Concurrent agents per workflow: `min(16, cpus - 2)`. Excess calls queue.
- Lifetime agent count per workflow: 1000.
- Items per `parallel`/`pipeline` call: 4096. Exceeding it is an explicit error.
- Every run persists the script to a file, writes a `journal.jsonl` of each agent's actual return value, and keeps one transcript file per agent.

### Resume

Relaunching with the script path plus a prior run ID replays the journal. The longest unchanged prefix of `agent()` calls, matched on prompt and options, returns cached results instantly. The first edited or new call and everything after it runs live. Same script plus same args is a full cache hit. This is the intended iteration loop: stop the run, edit the script file, resume.

### Patterns the reference teaches, not enforces

None of these are API. They are shapes written with the primitives above, and the CLI should ship them as documented examples rather than features.

- **Adversarial verify**: N independent refuters per finding, majority vote.
- **Perspective-diverse verify**: each verifier gets a distinct lens (correctness, security, perf, reproduces).
- **Judge panel**: N independent attempts from different angles, scored by parallel judges, synthesized from the winner.
- **Loop-until-dry**: keep spawning finders until K consecutive rounds return nothing new. Dedup against everything seen, not just what was confirmed, or it never converges.
- **Loop-until-budget**: scale depth to `budget.remaining()`.
- **Multi-modal sweep**: parallel searchers using different strategies, each blind to the others.
- **Completeness critic**: a final agent that asks what is missing.
- **No silent caps**: `log()` whatever a workflow drops.

Pipeline is the default. A barrier is only justified when a stage genuinely needs cross-item context from the whole previous stage: dedup across all findings, early exit on a zero count, or a prompt that references "the other findings".

## What the CLI keeps

Everything in the reference model above, with these primitives unchanged in name and semantics: `agent`, `pipeline`, `parallel`, `phase`, `log`, `args`, `workflow`. The `meta` header, the sandbox rules, the journal, and resume all carry over. Scripts written for Claude Code's Workflow tool should run under our CLI with at most the addition of a backend selection.

## What the CLI changes

### Scripts are files

The CLI takes a path to a script file, or `-` to read the script from stdin. There is no inline-script argument. The reference persists inline scripts to a file anyway and tells the author to edit that file for iteration, so starting from a file removes a step rather than adding one.

```
workflow run ./review.js --args '{"files": ["a.ts", "b.ts"]}'
workflow run ./review.js --args-file ./args.json
cat review.js | workflow run - --backend codex
workflow run ./review.js --resume wf_be28b885
```

The run directory holds a copy of the script as it was at launch, so resume compares against what actually ran, not against whatever the file says now.

### `info` describes everything a script author needs

The reference relies on an authoring skill that hard-codes the option names, model tiers, and limits. Ours cannot, because the set of backends and their models changes per machine. So the CLI has one command that reports everything needed to write a script for this installation, in a human-readable form by default and as JSON with `--json`:

```
$ workflow info
runtime
  script API      agent, pipeline, parallel, phase, log, args, budget, workflow
  concurrency     10 (min(16, cpus - 2))
  agent cap       1000 per run
  items per call  4096
  default backend claude

backends
  claude     available   claude 2.1.40    /opt/homebrew/bin/claude
    models   claude-fable-5-1 (default), claude-opus-5, claude-sonnet-5, claude-haiku-4-5-20251001
    effort   low, medium, high, xhigh, max
    output   structured: native   worktree: yes   tool-policy: allow/deny lists, read-only
  codex      available   codex 0.9.2      /opt/homebrew/bin/codex
    models   gpt-5.4 (default), gpt-5.4-mini
    effort   low, medium, high, xhigh
    output   structured: native   worktree: yes   tool-policy: read-only only
  opencode   available   opencode 1.4.0   ~/.local/bin/opencode
    models   anthropic/claude-sonnet-5 (default), openai/gpt-5.4, ...
    effort   not supported (ignored)
    output   structured: prompted  worktree: yes   tool-policy: none
  kimi       missing     install: https://...
  cursor     available   cursor-agent 3.2 /usr/local/bin/cursor-agent
    ...

profiles
  reviewer   backend=claude model=claude-opus-5 effort=high tool-policy=read-only
  fixer      backend=codex  effort=medium
```

Per backend it lists: availability and version, the binary path, the model identifiers the driver knows about with the default marked, which effort levels map to something real, the structured-output strategy, worktree support, and what tool policies the backend can enforce. It also lists any user-defined profiles (see Deferred) and the run-level defaults that apply when a script omits an option. Model lists come from the driver: a static table maintained per backend, refreshed from the vendor CLI where one exposes a model listing.

The bundled skill tells the author to run this command first and write the script against its output, so a script never references a model or backend that is not present.

### A bundled SKILL.md replaces the harness guidance

The reference's authoring guidance lives in a Claude Code skill and the Workflow tool description. Ours ships in the package as a `SKILL.md`, in the same format, so any harness that loads skills from a directory can use it. The CLI installs or prints it on request:

```
workflow skill --print          # to stdout
workflow skill --install .claude/skills/workflow
```

The skill covers what the reference guidance covers, adapted to this CLI:

- when a workflow is worth it and when to stay inline,
- the script shape, the `meta` header, the sandbox rules, and the full option list for `agent()`,
- the instruction to run `workflow info` first and use its output,
- pipeline versus barrier guidance,
- the recipe library: adversarial verify, perspective-diverse verify, judge panel, loop-until-dry, loop-until-budget, multi-modal sweep, completeness critic, no silent caps,
- the resume loop and how to read the journal before diagnosing an empty result,
- how the CLI presents results, so the author knows what will land in its context.

The skill is the primary documentation for script authors. The README is for humans installing the tool.

### Permissions: bypass mode only

Every backend has an interactive approval flow, and none of them can be driven from another process. The reference gets away with this because subagents inherit the parent session's permission mode and the user already chose bypass or an allowlist. A cross-vendor CLI has no such session, so the only mode that works everywhere is each backend's non-interactive, skip-approvals mode. Drivers use it unconditionally: `--dangerously-skip-permissions` for Claude Code, the equivalent full-auto flags for Codex and the others.

This is a design constraint, not a gap to fill later, and the CLI is honest about it:

- The first run prints a notice that agents run without approval prompts, and `info` repeats it.
- Worktree isolation and read-only tool policies are the mitigations, and the skill recommends them by default for any stage that does not need to write.
- Drivers expose whatever narrower policy the backend supports (read-only, deny lists, sandboxed shell) through the `toolPolicy` request field, and `info` reports what each backend can actually enforce so scripts do not assume a policy that is silently ignored.
- Running the CLI inside a container or VM is the recommended posture for untrusted repos, and the docs say so.

### Backends are explicit

`agent()` takes a `backend` option alongside `model` and `effort`:

```js
await agent(prompt, { backend: 'codex', model: 'gpt-5.4', effort: 'high', schema: FINDINGS })
```

A run-level default backend comes from the CLI flag or config, so scripts that never mention a backend still work. Per-call selection is the feature the reference does not have: a script can send cheap mechanical stages to one harness and hard verification stages to another, or run the same prompt through three vendors and vote.

Which backends are installed, and what models and options each accepts, comes from `workflow info` as described above. A script that names a missing backend fails at launch with the `info` output for that backend, not mid-run.

`workflow()` children accept a backend override as a third argument, `workflow(ref, args, { backend })`, which becomes the child's run-level default. Without it the child inherits the parent's default.

### Backend driver interface

Each backend is a driver behind one interface. The runtime never talks to a vendor directly.

```
detect()            -> { available, binary, version, notes }
run(request)        -> { text, structured?, usage?, exitInfo }

request = {
  prompt, cwd, model?, effort?, schema?,
  systemAppend?,       // the "your final text is a return value" preamble and StructuredOutput instructions
  toolPolicy?,         // allow/deny, or read-only
  signal,              // abort
  onEvent,             // streaming progress for the UI
}
```

Drivers wrap each vendor's headless mode: `claude -p --output-format json`, `codex exec`, and the equivalents for OpenCode, Kimi, and Cursor. A driver declares its capabilities so the runtime can pick the best structured-output strategy and warn when a script asks for something a backend cannot do.

Drivers come in two transports. The `cli` transport spawns the vendor binary per agent and parses its JSON output, with a parser per backend. The `acp` transport speaks the Agent Client Protocol (JSON-RPC over stdio) and covers every backend that has an ACP server with one parser, one model-discovery path, and one permission callback. OpenCode, Kimi, and Qwen ship ACP natively, and adapters exist for Claude Code and Codex. Prefer ACP where it is native. BACKENDS.md records what each transport looks like in practice.

### Structured output across heterogeneous backends

Claude Code forces a tool call. Not every harness exposes that, so the runtime supports two strategies and each driver declares which it uses:

1. **Native**: the backend accepts a JSON Schema and guarantees conforming output.
2. **Prompted**: the runtime appends instructions to emit a single fenced JSON block matching the schema, validates the result with a JSON Schema validator, and re-prompts on failure up to a bounded retry count. A final failure resolves the `agent()` call to `null`, matching the reference's failure contract.

Either way the script sees a validated object, never a string to parse.

### Worktree isolation is a first-class feature

`isolation: 'worktree'` is not deferred. Parallel agents that edit files are the main reason to fan out at all, and without isolation they clobber each other. The runtime creates a `git worktree` per agent on a throwaway branch, hands the driver that directory as `cwd`, and after the agent returns:

- removes the worktree if nothing changed,
- otherwise keeps it and records the branch and path in the agent's result metadata so a later stage (or the user) can merge, cherry-pick, or diff.

This is pure git plumbing around the driver's `cwd`, so it works identically for every backend. A plain `git worktree add` only carries tracked files, so agents that need untracked local state (env files, build caches, `node_modules`) will not find it. The runtime should offer an opt-in list of paths to copy or symlink into each worktree rather than pretending the problem does not exist.

### Progress and observability

The caller of this CLI is usually a model with a context window to protect, so output is designed for progressive disclosure. It mimics what the reference shows and hides.

**While running**, the terminal shows a live tree of phases and agents. Each agent line carries its label, elapsed time, tool-call count, and a one-line description of its current activity taken from the backend's stream (the tool it is calling, or the first line of its latest text). Narrator lines from `log()` appear above the tree. Nothing else from the agents' streams is shown. A `--json` mode emits the same events as newline-delimited JSON for other tools to render.

**On completion**, stdout gets a compact report: the summary from `meta`, agent counts (done, errored, skipped, empty), token and tool-call totals, duration, the `log()` lines, and then the script's return value. If the return value exceeds a size threshold it is written to a file in the run directory and stdout gets the path plus a preview of the first few kilobytes. This is exactly how the reference handles large results, and it matters: a workflow that fans out fifty agents can return more text than the caller can afford to read.

**On disk**, the run directory holds the script as launched, `args`, the journal of every agent's return value, one transcript per agent with the backend's full stream, and the worktree records. Drilling in is a separate command so nothing lands in the caller's context unless asked for:

```
workflow show wf_be28b885                  # report again, plus per-agent status table
workflow show wf_be28b885 --agent 4        # that agent's prompt, options, and return value
workflow show wf_be28b885 --agent 4 --transcript
workflow journal wf_be28b885               # the raw journal, for diagnosing empty results
```

The skill tells authors to read the journal before guessing why a result is empty, as the reference does.

## Subagent context

This section records what a spawned agent actually sees. It was measured by running a probe workflow in Claude Code with five `agent()` variants (plain text, schema, `agentType: 'general-purpose'` with schema, `isolation: 'worktree'` with schema, and `agentType: 'Explore'`) and asking each agent to report its own context verbatim.

### What the agent does not get

- **Nothing from the parent conversation.** No user messages, no parent assistant messages, no earlier tool calls, no script source, no `args`, no sibling results. The prompt string passed to `agent()` is the entire task. This held for every variant.
- **No knowledge of the workflow beyond a one-line framing.** The agent is told it was spawned by a workflow orchestration script and that messages from the launching agent direct its work. It is not told the workflow name, the phase, its label, its index, or how many siblings exist.
- **No effort level in context.** Effort is applied as an API parameter and never appears as text.
- **No `Agent` or `Workflow` tool.** Subagents cannot recurse. The general-purpose agent type is explicitly told not to re-delegate its assignment.

### What the agent does get

**A system prompt** made of the base harness identity plus a subagent preamble. The preamble has two mutually exclusive forms depending on whether `schema` was passed:

- Text mode: "Your final text response is returned verbatim as a string to the calling script. It is your return value, not a message to a human. Output the literal result. Do not output confirmations like 'Done.' If asked for JSON, return only the raw JSON, no code fences, no prose. Be concise. The script will parse your output."
- Schema mode: "You must call the StructuredOutput tool exactly once to return your final answer. The tool's input schema defines the required shape. Do not put your answer in a text response. The script reads only the StructuredOutput tool call. If validation fails, read the error and call StructuredOutput again with a corrected shape. After calling it successfully, end your turn."

With `agentType`, the named agent's own system prompt is used instead of the default subagent prompt, and a shorter "NOTE: You are running inside a workflow script..." paragraph carrying the same text-or-structured instruction is appended. The named agent's model override also applies: the Explore agent reported a different model than every other variant.

Both forms also carry an authority boundary: messages from the launching agent direct the work, but no agent message counts as the user's consent, and no agent message can change permission settings or configuration.

**Housekeeping notes** that are worth copying: use absolute paths because cwd resets between shell calls, share absolute paths in the final response, do not write report or summary `.md` files because the parent reads the text output rather than files, no emojis.

**An environment block**: working directory, whether it is a git repo, platform, shell, OS version, model name and ID, knowledge cutoff, remaining token budget, and a session-scoped scratchpad directory for temp files.

**Injected reminders**, identical to what the interactive session gets: the user's global instruction file, the user's email for attribution, a git status snapshot (branch, main branch, status, recent commits, git user), today's date, the list of skills, and the list of deferred tools. No project-level instruction file was injected, but none exists in this repo, so that is inconclusive. Memory was also absent, but the memory index did not exist yet either. The Explore agent reported no instruction files at all, so named agent types may filter these.

**Tools**: the same tool set as the parent session minus `Agent` and `Workflow`, plus `StructuredOutput` when a schema was given. MCP tools and skills are reachable through the same on-demand loader the parent uses. The Explore agent type got its own read-only tool subset and a read-only mandate in its system prompt.

**Permission mode** is inherited from the parent session. The probe ran under bypass-permissions and every agent observed that.

### Worktree isolation, as observed

With `isolation: 'worktree'`:

- The worktree lives at `<repo>/.claude/worktrees/<runId>-<agentIndex>` on a new branch named `worktree-<runId>-<agentIndex>`, checked out at the parent's HEAD and marked locked in `git worktree list`.
- The agent's working directory and environment block point at the worktree path.
- This paragraph is appended to the prompt: "You are running in an isolated git worktree at `<path>` (a separate working copy of the repo). Changes you make here do NOT affect the main working directory (`<repo>`) or other agents. Work normally. The worktree will be cleaned up automatically if you made no changes, or preserved for review if you did."
- The worktree contained only tracked files. Untracked files from the main checkout, including the `.claude` directory itself, were not present.
- The git status snapshot injected into context still described the parent checkout, so it reported the wrong branch. The scratchpad path was also keyed to the parent repo. Our CLI should regenerate both against the worktree.
- After the agent returned with no changes, the worktree and branch were removed. Siblings running without isolation could see the locked worktree in `git worktree list` while it existed.

### What this means for the CLI

The context contract is small and should be written down as a spec that every driver satisfies:

1. The prompt is the whole task. The runtime never leaks script state, args, or sibling output. Scripts that want context in the agent must put it in the prompt string.
2. The runtime appends a short preamble that names the return contract (text is the return value, or emit structured output exactly once) and the authority boundary. Drivers that support a system-prompt append use it; drivers that do not get the preamble prepended to the user prompt.
3. The runtime supplies cwd, and in worktree mode, the worktree path plus the isolation paragraph above.
4. Each backend's own instruction-file loading (CLAUDE.md, AGENTS.md, and equivalents) and tool set are the backend's business. Approval prompts are always disabled. The runtime passes a tool policy through where the backend has a flag for it and `info` reports what each backend can enforce.
5. Effort, model, and tool policy are request parameters, never prompt text.

## Deferred

- **`budget`**: needs reliable token accounting from every backend. Ship the global with `total: null` so scripts that guard on it degrade correctly, and wire up real accounting per driver as their usage reporting matures.
- **`agentType`**: a Claude Code registry concept. The equivalent here is a profile, a named bundle of backend, model, effort, system prompt append, and tool policy, defined in the CLI's config and referenced from a script as `agent(prompt, { profile: 'reviewer' })`. `info` already lists profiles. Design the config format after the driver interface settles.
- **MCP passthrough**: the reference lets subagents reach the session's MCP servers. Backends differ enough here that this is per-driver configuration, not a runtime feature.

## Open questions

- **Script runtime.** Bun is the leading choice: it is what Claude Code itself is built on, it runs JavaScript natively without a build step, and it can compile the CLI to a single binary. The remaining question is how to isolate the script. The reference's sandbox is about determinism (no `Date.now()`, no `Math.random()`, no filesystem) more than security, so a preamble that shadows those globals in a fresh module scope may be enough. Before committing, find out how Claude Code actually runs workflow scripts, whether that is an isolated VM context, a worker, or a subprocess, and match it if it is cheap to do so.
- **Model discovery.** Static per-driver model tables go stale. Decide per backend whether the vendor CLI can list models and whether calling it at `info` time is fast enough to be the default.
- **Structured output for prompted backends.** How many retries before giving up, and whether a partial-but-parseable object should be returned with a warning or dropped to `null` like the reference.

## Principles for implementation

This document will not survive contact with the real backends unchanged. When something in it turns out to be wrong, impossible, or underspecified, decide using these, in roughly this order.

- **Prefer simple and elegant code over complex workarounds that satisfy the letter of the spec.** If the spec asks for something that only a contortion can deliver, the spec is probably wrong. Say so and fix the spec.
- **Complete, least friction, least surprise. No shortcuts, no "prototype" quality.** Every feature is finished or explicitly marked unsupported. Nothing is half-wired.
- **The reference is the tiebreaker, not the spec.** When this document is silent or ambiguous, do what the Claude Code Workflow tool does, because scripts written for it are supposed to run here. When this document and the reference disagree, this document wins. When both are silent, pick the option that keeps scripts portable.
- **Determinism is load-bearing.** Resume replays the journal and matches `agent()` calls by their arguments. Anything that makes a script run differently twice, including in the runtime itself, breaks that. Treat it as a correctness property with tests, not a convention.
- **Backend differences are absorbed in drivers, never in the script API.** If a backend cannot do something, the driver declares it and `info` reports it. The `agent()` options mean the same thing on every backend or they do not exist.
- **Refuse early, never hang.** Every way a run can block on a human, such as a missing bypass config on kimi or a trust prompt on cursor, must be detected before spawning and turned into a launch-time error. A silent hang inside a fan-out of fifty agents is the worst failure mode this tool can have.
- **Verify against the real binaries, but not frivolously.** Every driver claim in BACKENDS.md was observed on this machine. When a driver's behavior is uncertain, run the probe rather than guessing from docs, and pin the assumption in the driver file with the version it was checked against. Every real agent session spends real quota on real subscriptions. Use the cheapest model a backend offers for verification (luna, sonnet, composer, haiku, and their equivalents), keep prompts trivial, and never loop a live probe. The committed test suite must not invoke the real binaries; drivers are tested against recorded fixtures of their output, and live probes are a separate, manually run target.
- **Fail loud, degrade explicitly.** An agent that returns `null` must say why in the journal. A capability that was dropped, such as effort on a backend without it, must be logged, not silently ignored. Silent truncation and silent fallback are both bugs.
- **The caller is a model.** Everything printed to stdout costs someone context. Default to compact, spill big things to files with a path, and make drilling in a separate command.
- **One escape hatch per layer.** The script sandbox, the transport, the schema strategy, and the worktree plumbing each get exactly one documented way to opt out or override. More than one and the layers stop being layers.
- **Log justifications for deviations in `DECISIONS.md`.** Each entry records what the document said, what was done instead, why, the alternative considered, and what it would take to reverse. The file also tells the next reader which parts of the plan are settled and which were revisited.
- **When blocked on a genuine unknown, ship the rest.** Do not stall the whole build on one backend or one feature. Land it behind a clear "unsupported" in `info`, record it in `DECISIONS.md`, and keep moving.

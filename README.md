# Workflow

Run deterministic JavaScript orchestration across coding agent harnesses.
Scripts fan work out, verify outputs, and replay unchanged calls after edits.
Claude, Codex, and Cursor use their headless CLIs; OpenCode, Kimi, and Qwen use
native ACP.

See [implementation status](docs/STATUS.md) for what is implemented, what is
deferred, and how to verify it.

## Install from this checkout

Install [mise](https://mise.jdx.dev), then:

```sh
mise trust
mise install
mise run build
node dist/cli.js --help
```

The CLI requires Node 24 or later and macOS or Linux (Windows uses WSL). Install
and authenticate the vendor CLIs you intend to use. `workflow info` detects
their binaries, capabilities, and model catalogs. Discovery can create vendor
ACP sessions but sends no agent prompts. Backend sessions may persist in the
vendor's own storage.

To install the built package locally:

```sh
mise x -- pnpm pack
npm install --global ./sargunv-workflow-0.1.0.tgz
workflow info
workflow skill --install .claude/skills/workflow
```

The [bundled skill](skills/workflow/SKILL.md) documents the complete script API,
workflow patterns, and harness/model selection. Installation copies the whole
skill directory, including its Claude and GPT references. Reinstalling updates
bundled files and preserves unrelated files in the destination. `workflow skill
--print` prints only the `SKILL.md` entrypoint; install the skill to make its
linked references available locally. The
[runnable recipe library](examples/README.md) includes all eight review and
convergence patterns, with documented inputs and offline behavior tests.

## Run and inspect

Use an available backend and model from `workflow info`. Claude lists aliases;
full model IDs accepted by its CLI also work. `run --backend` and `run --model`
set run defaults; explicit agent/profile selections can override them:

```sh
workflow run ./examples/hello.js --args '{"backend":"claude","model":"claude-haiku-4-5-20251001"}'
workflow run ./examples/hello.js --background --args '{"backend":"claude","model":"claude-haiku-4-5-20251001"}'
workflow wait wf_012345abcdef
workflow show wf_012345abcdef
workflow skip wf_012345abcdef 1
workflow stop wf_012345abcdef
workflow show wf_012345abcdef --agent 1 --transcript
workflow journal wf_012345abcdef
workflow run ./examples/hello.js --resume wf_012345abcdef
```

`--args-file` reads JSON input from disk. `run -` reads a script from stdin.
`--json` emits NDJSON events and a compact final report. Terminal progress goes
to stderr; results go to stdout. Large results spill to a file with a bounded
preview. Background launch returns a run ID after preflight. `wait` shows live
progress; Ctrl-C stops that view while the run continues. `stop` waits for
worker cleanup, and `skip` targets one queued or running leaf. Repeated signals
to foreground runs remain cancellation requests and do not bypass cleanup.

Confirmed Claude/Codex subscription refusals also stop the run and report
limit/reset details. Resume after access returns; completed prefix calls replay
and the interrupted suffix runs live. Workflow does not wait or retry
automatically.

Add `.workflow/` to your repository's `.gitignore`. Run records live in
`.workflow/runs/` under the agent working directory; use `--runs-dir` to choose
another location. Agent working directories default to the current directory and
can be set with `--cwd`. Inspection/control commands accept the same `--cwd` and
`--runs-dir` options. Run control uses a local TCP connection authenticated with
a per-run secret stored in its private directory; stored PIDs are never used to
signal a different process.

Agents run without approval prompts. Read-only tool policies are enforced only
on backends that advertise support; unsupported restrictions fail explicitly.
Use worktree isolation for parallel edits and a container or VM for untrusted
repositories. Worktrees start at HEAD and retain changed or committed work for
review. Resume does not make external edits transactional; inspect the journal
and retained work before replaying an interrupted editing task.

## Configuration

Global configuration lives at `$XDG_CONFIG_HOME/workflow/config.json`,
defaulting to `~/.config/workflow/config.json`. `.workflow/config.json` in the
working directory overrides global fields; `defaults`, `transport`, `sandbox`
and each named profile merge field by field. Run flags override those defaults.

```json
{
  "backend": "claude",
  "concurrency": 8,
  "defaults": { "effort": "medium" },
  "profiles": {
    "reviewer": {
      "backend": "claude",
      "effort": "high",
      "toolPolicy": "read-only",
      "systemAppend": "Report only findings supported by concrete evidence."
    }
  },
  "sharedPaths": [{ "path": "node_modules", "mode": "symlink" }],
  "schemaRetries": 2,
  "schemaStrategy": "auto",
  "sandbox": { "memoryBytes": 67108864, "instructions": 100000 },
  "transport": {
    "agentTimeoutMs": 3600000,
    "discoveryTimeoutMs": 20000,
    "launchTimeoutMs": 120000
  }
}
```

Worktree shared paths are opt-in and repository-relative. `copy` duplicates
local state; `symlink` shares writable state with the parent. Prefer copying
anything that must remain isolated. Profiles can be selected with `agent(prompt,
{ profile: 'reviewer' })`; explicit call options take precedence. The top-level
`backend` is the only run-level backend default; `defaults.backend` is rejected.
Transport deadlines are configurable and reported by `info`; expiry cancels
owned processes rather than leaving an approval prompt or a hung worker running.
Budget enforcement and harness-specific `agentType` are deferred as described in
[decisions](DECISIONS.md).

## Development

```sh
mise run test
mise run check
mise run typecheck
mise run build
```

The committed suite invokes only fixtures and local test programs, never real
agent subscriptions. See [VISION.md](VISION.md) for the product brief and
[DECISIONS.md](DECISIONS.md) for implementation choices and limitations.

To deliberately verify a changed backend against a real binary, run `mise run
probe -- --backend <name> --model <cheap-model>`. This manual target consumes
quota; it is separate from the offline suite and never retries a probe.

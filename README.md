# Workflow

A CLI that runs JavaScript workflow scripts across coding agents. A script fans
tasks out to leaf agents, verifies their output and returns structured data; the
agents can be Claude Code, Codex or Cursor through their headless CLIs, or
OpenCode, Kimi or Qwen through ACP. Scripts run in a deterministic QuickJS
sandbox and every agent call is journaled, so after editing a script you can
resume a run and replay its calls up to the first change; everything from there
on runs live. The script API follows Claude Code's Workflow tool.

## Example

```js
export const meta = {
  name: "review",
  description: "Find a bug in each file, then try to refute it",
};

return pipeline(
  args.files,
  (file) =>
    agent(`Report the most serious bug in ${file}.`, {
      label: file,
      toolPolicy: "read-only",
    }),
  (bug, file) =>
    bug &&
    agent(`Try to disprove this report on ${file}: ${bug}`, {
      toolPolicy: "read-only",
    }),
);
```

```sh
workflow-cli run review.js --backend claude --model <model from workflow-cli info> \
  --args '{"files":["/repo/src/cache.ts","/repo/src/queue.ts"]}'
```

Each file gets its own finder agent, and each verifier starts as soon as its
finder returns; a failed agent returns `null`. Live progress goes to stderr and
the result to stdout. The run is recorded under `.workflow/runs/`; edit the
script and pass `--resume <run-id>` to replay calls from the journal until the
first changed one; later calls run live.

## Install

The package is not published yet. Install [mise](https://mise.jdx.dev), then
build and install from a checkout; this puts a `workflow-cli` executable on your
`PATH`:

```sh
mise trust
mise install
mise x -- pnpm pack
npm install --global ./sargunv-workflow-0.1.0.tgz
workflow-cli skill --install ~/.claude/skills/workflow
```

Workflow requires Node 24 or later on macOS or Linux (use WSL on Windows).
Install and authenticate the agent CLIs you want to use, then run `workflow-cli
info` to see which backends, models, effort levels and tool policies are
available.

## Commands

| Command                                       | Purpose                                                    |
| --------------------------------------------- | ---------------------------------------------------------- |
| `workflow-cli info`                           | Detect installed backends and their capabilities           |
| `workflow-cli run <script>`                   | Run a script file, or `-` for stdin                        |
| `workflow-cli run <script> --background`      | Return a run ID after preflight and keep running           |
| `workflow-cli run <script> --resume <run-id>` | Replay a previous run up to the first change               |
| `workflow-cli wait <run-id>`                  | Follow a background run and print its result               |
| `workflow-cli show <run-id>`                  | Summarize a run; `--agent <id> [--transcript]` drills in   |
| `workflow-cli journal <run-id>`               | Print the raw agent result journal                         |
| `workflow-cli skip <run-id> <agent-id>`       | Skip one queued or running agent                           |
| `workflow-cli stop <run-id>`                  | Cancel a run and wait for its workers to shut down         |
| `workflow-cli skill --install <directory>`    | Install the authoring skill into a harness skill directory |

`run` accepts `--args <json>` or `--args-file <path>`, run defaults `--backend`
and `--model`, and `--json` for NDJSON events. Run and inspection commands take
`--cwd` for the agent working directory and `--runs-dir` for run storage. Add
`.workflow/` to your `.gitignore`.

Agents run without approval prompts. Use `toolPolicy: 'read-only'` for review
work on backends that enforce it, `isolation: 'worktree'` for parallel edits,
and a container or VM for untrusted repositories.

## Configuration

Global settings live in `~/.config/workflow/config.json` (or under
`$XDG_CONFIG_HOME`). `.workflow/config.json` in the working directory overrides
them field by field, and run flags override both.

```json
{
  "backend": "claude",
  "concurrency": 8,
  "defaults": { "effort": "medium" },
  "profiles": {
    "reviewer": {
      "effort": "high",
      "toolPolicy": "read-only",
      "systemAppend": "Report only findings supported by concrete evidence."
    }
  },
  "sharedPaths": [{ "path": "node_modules", "mode": "symlink" }]
}
```

Select a profile with `agent(prompt, { profile: 'reviewer' })`. Sandbox limits,
transport deadlines and schema settings are described in the skill.

## Further reading

- [Authoring skill](skills/workflow/SKILL.md): the script API, resume semantics
  and model selection.
- [Examples](examples/README.md): runnable review and convergence recipes.
- [Roadmap](ROADMAP.md): what is not supported yet.
- [AGENTS.md](AGENTS.md): development setup and design notes.

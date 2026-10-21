import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultTransport } from "../config.ts";
import type { TransportSettings } from "../config.ts";
import type {
  Detection,
  Driver,
  DriverEvent,
  DriverRequest,
  ModelInfo,
} from "../types.ts";
import { effort, errorText, ProcessOwnershipError } from "../types.ts";
import { availableBinary, composePrompt, detectBackend } from "./backend.ts";
import {
  ClaudeEventParser,
  CodexEventParser,
  CursorEventParser,
  GrokEventParser,
  array,
  object,
  string,
} from "./events.ts";
import type { CliEventParser } from "./events.ts";
import { capture, ManagedProcess } from "./process.ts";

export function codexModels(output: string): ModelInfo[] {
  const data: unknown = JSON.parse(output);
  const entries = Array.isArray(data) ? data : array(object(data).models);

  return entries
    .map(object)
    .filter((model) => model.visibility !== "hide")
    .map((model) => ({
      id: string(model.slug),
      efforts: array(model.supported_reasoning_levels)
        .map((level) => string(object(level).effort))
        .filter((level) => effort.safeParse(level).success),
    }))
    .filter((model) => model.id);
}

export function cursorModels(output: string): ModelInfo[] {
  return output
    .split("\n")
    .map((line) => /^\s*([\w./[\],=:-]+)\s+-\s+(.+)$/.exec(line))
    .flatMap((match) =>
      match?.[1]
        ? [
            {
              id: match[1],
              default: match[1] === "auto",
              efforts: [],
            },
          ]
        : [],
    );
}

export function grokModels(output: string): ModelInfo[] {
  return output
    .split("\n")
    .map((line) => /^\s*([-*])\s+(\S+)/.exec(line))
    .flatMap((match) =>
      match?.[2]
        ? [{ id: match[2], default: match[1] === "*", efforts: [] }]
        : [],
    );
}

interface CliInvocation {
  argv: string[];
  stdin: string;
  /** Written to the prompt path for backends that do not read stdin. */
  promptFile?: string;
  warning?: string;
}

interface CliBackend {
  executable: string;
  notes: string[];
  structured: Detection["structured"];
  toolPolicies: string[];
  readTools: string[];
  minimal?: () => boolean;
  /** A static list, or the subcommand that lists models and its parser. */
  models:
    | ModelInfo[]
    | { argv: string[]; parse: (output: string) => ModelInfo[] };
  invocation: (
    request: DriverRequest,
    schemaPath: string | undefined,
    promptPath: string,
  ) => CliInvocation;
  parser: (emit: (event: DriverEvent) => void) => CliEventParser;
}

const claudeReadTools = ["Read", "Grep", "Glob"];

const grokReadTools = ["read_file", "grep", "list_dir"];

// Flags and event shapes verified against Claude 2.1.261, Codex 0.153.3,
// Cursor 2026.09.02 and Grok 1.0.62. Tests use fixtures, never subscriptions.
const backends = {
  claude: {
    executable: "claude",
    notes: [
      "Model aliases are a sample; any model ID claude accepts passes through",
      "Omit model to use Claude's configured default",
      "Minimal mode (--bare) skips OAuth, so it requires ANTHROPIC_API_KEY",
    ],
    structured: "native",
    toolPolicies: ["read-only", "allow", "deny"],
    readTools: claudeReadTools,
    minimal: () => !!process.env.ANTHROPIC_API_KEY?.trim(),
    models: [
      { id: "fable", efforts: [] },
      { id: "opus", efforts: [] },
      { id: "sonnet", efforts: [] },
      { id: "haiku", efforts: [] },
    ],
    invocation: claudeInvocation,
    parser: (emit) => new ClaudeEventParser(emit),
  },
  codex: {
    executable: "codex",
    notes: [
      "Omit model to use Codex's configured default",
      "Hidden models and unsupported effort levels are not listed",
    ],
    structured: "native",
    toolPolicies: ["read-only"],
    readTools: [],
    models: { argv: ["debug", "models"], parse: codexModels },
    invocation: codexInvocation,
    parser: (emit) => new CodexEventParser(emit),
  },
  cursor: {
    executable: "cursor-agent",
    notes: [
      "Effort is part of the model ID (for example -high); separate effort is ignored",
    ],
    structured: "prompted",
    toolPolicies: ["read-only"],
    readTools: [],
    models: { argv: ["models"], parse: cursorModels },
    invocation: cursorInvocation,
    parser: (emit) => new CursorEventParser(emit),
  },
  grok: {
    executable: "grok",
    notes: [
      "Omit model to use Grok's configured default",
      "Grok ignores effort, with a warning, for models without effort levels",
    ],
    structured: "native",
    toolPolicies: ["read-only", "allow", "deny"],
    readTools: grokReadTools,
    models: { argv: ["models"], parse: grokModels },
    invocation: grokInvocation,
    parser: (emit) => new GrokEventParser(emit),
  },
} satisfies Record<string, CliBackend>;

function claudeInvocation(request: DriverRequest): CliInvocation {
  const argv = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--append-system-prompt",
    request.systemAppend,
  ];

  if (request.model) {
    argv.push("--model", request.model);
  }

  if (request.effort) {
    argv.push("--effort", request.effort);
  }

  if (request.schema) {
    argv.push("--json-schema", JSON.stringify(request.schema));
  }

  if (request.minimal) {
    argv.push("--bare");
  }

  // Exclude orchestration tools; leaves cannot re-delegate their assignment.
  const deny = ["Agent", "Workflow"];
  if (request.toolPolicy === "read-only") {
    argv.push("--tools", claudeReadTools.join(","));
  } else if (request.toolPolicy) {
    if (request.toolPolicy.allow) {
      argv.push("--tools", request.toolPolicy.allow.join(","));
    }

    if (request.toolPolicy.deny) {
      deny.push(...request.toolPolicy.deny);
    }
  }

  argv.push("--disallowedTools", deny.join(","));

  return { argv, stdin: request.prompt };
}

function codexInvocation(
  request: DriverRequest,
  schemaPath?: string,
): CliInvocation {
  const argv = ["exec", "--json", "--skip-git-repo-check", "-C", request.cwd];

  if (request.toolPolicy === "read-only") {
    argv.push("-s", "read-only");
  } else if (request.toolPolicy) {
    throw new Error("Codex cannot enforce allow/deny tool lists");
  } else {
    argv.push("--dangerously-bypass-approvals-and-sandbox");
  }

  if (request.model) {
    argv.push("-m", request.model);
  }

  if (request.effort) {
    argv.push("-c", `model_reasoning_effort=${request.effort}`);
  }

  if (request.schema && schemaPath) {
    argv.push("--output-schema", schemaPath);
  }

  if (request.minimal) {
    throw new Error("Codex does not support minimal context mode");
  }

  argv.push("-");

  return { argv, stdin: composePrompt(request) };
}

function cursorInvocation(request: DriverRequest): CliInvocation {
  const argv = [
    "-p",
    "--output-format",
    "stream-json",
    "--yolo",
    "--trust",
    "--workspace",
    request.cwd,
  ];

  if (request.toolPolicy === "read-only") {
    argv.push("--mode", "plan");
  } else if (request.toolPolicy) {
    throw new Error("Cursor cannot enforce allow/deny tool lists");
  }

  if (request.model) {
    argv.push("--model", request.model);
  }

  if (request.minimal) {
    throw new Error("Cursor does not support minimal context mode");
  }

  const prompt = composePrompt(request);
  if (Buffer.byteLength(prompt) > 100_000) {
    throw new Error(
      "Cursor accepts prompts through argv; prompt exceeds safe 100 kB limit",
    );
  }

  argv.push(prompt);

  const warning = request.effort
    ? "Cursor effort must be selected using a model ID listed by workflow-cli info; separate effort was not applied"
    : undefined;

  return { argv, stdin: "", warning };
}

function grokInvocation(
  request: DriverRequest,
  schemaPath: string | undefined,
  promptPath: string,
): CliInvocation {
  // Headless grok never reads stdin. --verbatim keeps a task that starts with a
  // slash command or names a skill from being resolved as one.
  const argv = [
    "--prompt-file",
    promptPath,
    "--verbatim",
    "--output-format",
    "streaming-messages-json",
    "--always-approve",
    "--no-auto-update",
    "--cwd",
    request.cwd,
    "--rules",
    request.systemAppend,
  ];

  if (request.model) {
    argv.push("--model", request.model);
  }

  if (request.effort) {
    argv.push("--effort", request.effort);
  }

  if (request.schema) {
    argv.push("--json-schema", JSON.stringify(request.schema));
  }

  if (request.minimal) {
    throw new Error("Grok does not support minimal context mode");
  }

  // Exclude orchestration tools; leaves cannot re-delegate their assignment.
  const deny = ["Agent", "workflow"];
  let allow: string[] | undefined;
  if (request.toolPolicy === "read-only") {
    allow = grokReadTools;
  } else if (request.toolPolicy) {
    allow = request.toolPolicy.allow;
    deny.push(...(request.toolPolicy.deny ?? []));
  }

  // Grok reads an empty allowlist as no allowlist, and has no way to grant
  // nothing. An allowlist keeps the MCP meta-tools unless they are also denied.
  if (allow) {
    const granted = allow;
    if (!granted.length) {
      throw new Error("Grok cannot enforce an empty tool allowlist");
    }

    argv.push("--tools", granted.join(","));
    deny.push(
      ...["search_tool", "use_tool"].filter((tool) => !granted.includes(tool)),
    );
  }

  argv.push("--disallowed-tools", deny.join(","));

  return { argv, stdin: "", promptFile: request.prompt };
}

export class CliDriver implements Driver {
  private detection?: Detection;

  private backend: CliBackend;

  readonly name: keyof typeof backends;

  private transport: TransportSettings;

  constructor(
    name: keyof typeof backends,
    transport: TransportSettings = defaultTransport,
  ) {
    this.name = name;
    this.transport = transport;
    this.backend = backends[name];
  }

  async detect(
    cwd: string,
    signal = new AbortController().signal,
  ): Promise<Detection> {
    signal.throwIfAborted();
    this.detection ??= await detectBackend(
      this.backend.executable,
      {
        name: this.name,
        notes: [...this.backend.notes],
        transport: "cli",
        models: Array.isArray(this.backend.models) ? this.backend.models : [],
        structured: this.backend.structured,
        correction: "turn",
        worktree: true,
        toolPolicies: this.backend.toolPolicies,
        readTools: this.backend.readTools,
        minimal: this.backend.minimal?.() ?? false,
        usage: true,
      },
      cwd,
      this.transport.discoveryTimeoutMs,
      signal,
      (binary, detection) => this.listModels(binary, detection, cwd, signal),
    );

    return this.detection;
  }

  async run(request: DriverRequest) {
    const binary = availableBinary(
      await this.detect(request.cwd, request.signal),
    );
    const temporary = await mkdtemp(join(tmpdir(), "workflow-driver-"));
    try {
      const schemaPath = request.schema
        ? join(temporary, "schema.json")
        : undefined;
      if (schemaPath) {
        await writeFile(schemaPath, JSON.stringify(request.schema));
      }

      const promptPath = join(temporary, "prompt.txt");
      const invocation = this.backend.invocation(
        request,
        schemaPath,
        promptPath,
      );
      if (invocation.promptFile !== undefined) {
        await writeFile(promptPath, invocation.promptFile);
      }

      if (invocation.warning) {
        request.onEvent({ type: "warning", text: invocation.warning });
      }

      const parser = this.backend.parser(request.onEvent);
      const child = new ManagedProcess(binary, invocation.argv, {
        cwd: request.cwd,
        signal: request.signal,
        timeoutMs: this.transport.agentTimeoutMs,
        onLine: (line, channel) => parser.line(line, channel),
      });

      child.end(invocation.stdin);
      const exit = await child.exited;
      if (exit.cleanupUncertain) {
        throw new ProcessOwnershipError(exit.error);
      }

      return parser.finish(exit.code, exit.error, exit.stderr);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async listModels(
    binary: string,
    detection: Detection,
    cwd: string,
    signal: AbortSignal,
  ) {
    const { models } = this.backend;
    if (Array.isArray(models)) {
      return;
    }

    try {
      const output = await capture(
        binary,
        models.argv,
        cwd,
        this.transport.discoveryTimeoutMs,
        signal,
      );
      detection.models = models.parse(output);
      if (!detection.models.length) {
        detection.notes.push(
          "Model listing was not recognized; backend default is used when model is omitted",
        );
      }
    } catch (error) {
      detection.notes.push(`Model discovery failed: ${errorText(error)}`);
    }
  }
}

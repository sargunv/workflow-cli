import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultTransport } from "../config.js";
import type { TransportSettings } from "../config.js";
import type {
  Detection,
  Driver,
  DriverEvent,
  DriverRequest,
  ModelInfo,
} from "../types.js";
import { effort, errorText, ProcessOwnershipError } from "../types.js";
import { availableBinary, composePrompt, detectBackend } from "./backend.js";
import {
  ClaudeEventParser,
  CodexEventParser,
  CursorEventParser,
  array,
  object,
  string,
} from "./events.js";
import type { CliEventParser } from "./events.js";
import { capture, ManagedProcess } from "./process.js";

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

interface CliInvocation {
  argv: string[];
  stdin: string;
  warning?: string;
}

interface CliBackend {
  executable: string;
  notes: string[];
  structured: Detection["structured"];
  toolPolicies: string[];
  minimal?: () => boolean;
  /** A static list, or the subcommand that lists models and its parser. */
  models:
    | ModelInfo[]
    | { argv: string[]; parse: (output: string) => ModelInfo[] };
  invocation: (request: DriverRequest, schemaPath?: string) => CliInvocation;
  parser: (emit: (event: DriverEvent) => void) => CliEventParser;
}

// Flags and event shapes verified against Claude 2.1.261, Codex 0.153.3 and
// Cursor 2026.09.02. Tests use fixtures, never subscriptions.
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
    models: { argv: ["models"], parse: cursorModels },
    invocation: cursorInvocation,
    parser: (emit) => new CursorEventParser(emit),
  },
} satisfies Record<string, CliBackend>;

function claudeInvocation(request: DriverRequest): CliInvocation {
  const argv = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
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
    argv.push("--tools", "Read,Grep,Glob");
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
  const argv = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "-C",
    request.cwd,
  ];

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

export class CliDriver implements Driver {
  private detection?: Detection;

  private backend: CliBackend;

  constructor(
    readonly name: keyof typeof backends,
    private transport: TransportSettings = defaultTransport,
  ) {
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

      const invocation = this.backend.invocation(request, schemaPath);
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

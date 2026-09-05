import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultTransport } from "../config.js";
import type { TransportSettings } from "../config.js";
import type { Detection, Driver, DriverRequest, ModelInfo } from "../types.js";
import { effort, errorText, ProcessOwnershipError } from "../types.js";
import { CliEventParser, array, object, string } from "./events.js";
import { capture, findBinary, ManagedProcess } from "./process.js";

// Flags and event shapes verified in BACKENDS.md against Claude 2.1.261,
// Codex 0.153.3 and Cursor 2026.09.02. Tests use fixtures, never subscriptions.
export type CliBackend = "claude" | "codex" | "cursor";

const binaries = { claude: "claude", codex: "codex", cursor: "cursor-agent" };

const capabilityNotes: Record<CliBackend, string> = {
  claude:
    "Static model IDs; configured default and per-model effort support are not exposed by the CLI. --effort accepts low, medium, high, xhigh, max; requested levels are passed to Claude for validation. Minimal (--bare) disables OAuth/keychain authentication; Workflow enables it only with ANTHROPIC_API_KEY. Helper-only authentication is not discovered.",
  codex:
    "The model catalog does not identify the configured default; omitting model delegates to Codex configuration. Hidden models and effort levels outside Workflow's low/medium/high/xhigh/max API are omitted.",
  cursor:
    "Effort is encoded in the listed model IDs (for example -high or -xhigh); a separate effort override is unsupported and warns when ignored.",
};

const claudeModels: ModelInfo[] = [
  {
    id: "claude-fable-5-1",
    efforts: [],
  },
  { id: "claude-opus-5", efforts: [] },
  { id: "claude-sonnet-5", efforts: [] },
  { id: "claude-haiku-4-5-20251001", efforts: [] },
];

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
}

function claudeArguments(request: DriverRequest): CliInvocation {
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

function codexArguments(
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

  return { argv, stdin: `${request.systemAppend}\n\nTask:\n${request.prompt}` };
}

function cursorArguments(request: DriverRequest): CliInvocation {
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

  if (request.effort) {
    request.onEvent({
      type: "warning",
      text: "Cursor effort must be selected using a model ID listed by workflow info; separate effort was not applied",
    });
  }

  if (request.minimal) {
    throw new Error("Cursor does not support minimal context mode");
  }

  const combinedPrompt = `${request.systemAppend}\n\nTask:\n${request.prompt}`;
  if (Buffer.byteLength(combinedPrompt) > 100_000) {
    throw new Error(
      "Cursor accepts prompts through argv; prompt exceeds safe 100 kB limit",
    );
  }

  argv.push(combinedPrompt);

  return { argv, stdin: "" };
}

export function cliArguments(
  backend: CliBackend,
  request: DriverRequest,
  schemaPath?: string,
): CliInvocation {
  switch (backend) {
    case "claude":
      return claudeArguments(request);
    case "codex":
      return codexArguments(request, schemaPath);
    case "cursor":
      return cursorArguments(request);
  }
}

export class CliDriver implements Driver {
  private detection?: Detection;

  constructor(
    readonly name: CliBackend,
    private transport: TransportSettings = defaultTransport,
  ) {}

  async detect(
    cwd: string,
    signal = new AbortController().signal,
  ): Promise<Detection> {
    signal.throwIfAborted();
    if (this.detection) {
      return this.detection;
    }

    const binary = await findBinary(binaries[this.name]);
    const detection: Detection = {
      name: this.name,
      available: !!binary,
      binary,
      notes: [],
      transport: "cli",
      models: this.name === "claude" ? claudeModels : [],
      structured: this.name === "cursor" ? "prompted" : "native",
      correction: "turn",
      worktree: true,
      toolPolicies:
        this.name === "claude" ? ["read-only", "allow", "deny"] : ["read-only"],
      minimal:
        this.name === "claude" && !!process.env.ANTHROPIC_API_KEY?.trim(),
      usage: true,
    };

    detection.notes.push(capabilityNotes[this.name]);
    if (!binary) {
      detection.notes.push(
        `Install ${binaries[this.name]} and authenticate it before running workflows`,
      );
    } else {
      try {
        detection.version = await capture(
          binary,
          ["--version"],
          cwd,
          this.transport.discoveryTimeoutMs,
          signal,
        );
      } catch (error) {
        detection.available = false;
        detection.notes.push(errorText(error));
      }

      if (detection.available && this.name !== "claude") {
        try {
          const output = await capture(
            binary,
            this.name === "codex" ? ["debug", "models"] : ["models"],
            cwd,
            this.transport.discoveryTimeoutMs,
            signal,
          );

          if (this.name === "codex") {
            detection.models = codexModels(output);
          } else {
            detection.models = cursorModels(output);
          }

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

    signal.throwIfAborted();
    this.detection = detection;

    return detection;
  }

  async run(request: DriverRequest) {
    const detection = await this.detect(request.cwd, request.signal);
    if (!detection.available || !detection.binary) {
      throw new Error(
        `${this.name} unavailable: ${detection.notes.join("; ")}`,
      );
    }

    const temporary = await mkdtemp(join(tmpdir(), "workflow-driver-"));
    try {
      const schemaPath = request.schema
        ? join(temporary, "schema.json")
        : undefined;
      if (schemaPath) {
        await writeFile(schemaPath, JSON.stringify(request.schema));
      }

      const invocation = cliArguments(this.name, request, schemaPath);
      const parser = new CliEventParser(this.name, request.onEvent);
      const child = new ManagedProcess(detection.binary, invocation.argv, {
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

      return parser.finish(
        exit.code,
        exit.error ?? (exit.code !== 0 ? exit.stderr : undefined),
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

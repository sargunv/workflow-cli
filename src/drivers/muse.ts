import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultTransport } from "../config.js";
import type { TransportSettings } from "../config.js";
import type { Detection, Driver, DriverRequest } from "../types.js";
import { errorText } from "../types.js";
import { runCli } from "./cli.js";
import { MuseEventParser } from "./events.js";
import { capture, findBinary } from "./process.js";

// Invocation and event shapes verified against Muse Code 1.4.7: a strict
// schema probe on muse-spark-1.3, plus write and read-only enforcement
// probes. Flag acceptance and reminder suppression were rechecked with the
// quota-free echo provider. Tests use fixtures, never subscriptions.

export function museArguments(
  request: DriverRequest,
  promptPath: string,
  schemaPath?: string,
): string[] {
  const argv = [
    "exec",
    "--json",
    "--disable-approval",
    "--disable-reminders",
    "--trust-workspace",
    "--no-session-log",
    "--workspace",
    request.cwd,
    "--prompt-file",
    promptPath,
  ];

  // Write mode is unsandboxed like the other harnesses: a worktree's Git
  // metadata lives outside the workspace root, and builds may need network.
  if (request.toolPolicy === "read-only") {
    argv.push("--disable-write", "--disable-shell", "--disable-web-tools");
  } else if (request.toolPolicy) {
    throw new Error("Muse cannot enforce allow/deny tool lists");
  } else {
    argv.push("--disable-sandbox");
  }

  if (request.model) {
    argv.push("--model", request.model);
  }

  if (request.effort) {
    argv.push("--reasoning-effort", request.effort);
  }

  if (request.schema && schemaPath) {
    argv.push("--output-schema", schemaPath);
  }

  if (request.minimal) {
    throw new Error("Muse does not support minimal context mode");
  }

  return argv;
}

export class MuseDriver implements Driver {
  readonly name = "muse" as const;

  private detection: Detection | undefined;

  constructor(private transport: TransportSettings = defaultTransport) {}

  async detect(
    cwd: string,
    signal = new AbortController().signal,
  ): Promise<Detection> {
    signal.throwIfAborted();
    if (this.detection) {
      return this.detection;
    }

    const binary = await findBinary("muse");
    const detection: Detection = {
      name: "muse",
      available: !!binary,
      binary,
      notes: [
        "muse exposes no model catalog, so no models are listed; any model ID accepted by muse can be passed through. Omit model to use Muse's configured default. muse exec does not report token usage, so usage is unavailable, and subscription limits are not classified separately from other failures. Leaf workers are told not to delegate, but muse exec has no flag that disables subagents. Native structured output requires a strict-compatible schema (additionalProperties: false with every property required); other schemas use prompted output validated against the original schema.",
      ],
      transport: "cli",
      models: [],
      structured: "native",
      correction: "turn",
      worktree: true,
      toolPolicies: ["read-only"],
      minimal: false,
      usage: false,
    };

    if (!binary) {
      detection.notes.push(
        "Install muse and authenticate it before running workflows",
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
    }

    signal.throwIfAborted();
    this.detection = detection;

    return detection;
  }

  async run(request: DriverRequest) {
    const detection = await this.detect(request.cwd, request.signal);
    if (!detection.available || !detection.binary) {
      throw new Error(`muse unavailable: ${detection.notes.join("; ")}`);
    }

    return runCli(
      detection.binary,
      request,
      this.transport.agentTimeoutMs,
      new MuseEventParser(request.onEvent),
      async (temporary, schemaPath) => {
        const promptPath = join(temporary, "prompt.txt");
        await writeFile(
          promptPath,
          `${request.systemAppend}\n\nTask:\n${request.prompt}`,
        );

        return {
          argv: museArguments(request, promptPath, schemaPath),
          stdin: "",
        };
      },
    );
  }
}

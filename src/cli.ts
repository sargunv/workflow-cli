#!/usr/bin/env node
import { readFile, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import { z } from "zod";

import { launchBackground, readLaunch, notifyLauncher } from "./background.js";
import type { Launch } from "./background.js";
import { loadConfig } from "./config.js";
import { createDrivers } from "./drivers/index.js";
import { inspectInstallation, formatInstallation } from "./info.js";
import { notice, firstRunNotice } from "./notice.js";
import { printReport } from "./output.js";
import { Progress } from "./progress.js";
import { controlRun, inspectReport } from "./runtime/control.js";
import { runWorkflow } from "./runtime/run.js";
import { readScriptFile } from "./runtime/script.js";
import { runPath } from "./runtime/store.js";
import type { Report } from "./runtime/store.js";
import { readTranscript } from "./runtime/transcript.js";
import { backendName, errorText, isErrno, jsonValue } from "./types.js";
import { version } from "./version.js";
import { waitForRun } from "./wait.js";

interface StorageOptions {
  runsDir?: string;
  cwd?: string;
  json?: boolean;
}

interface RunOptions extends StorageOptions {
  model?: string;
  args?: string;
  argsFile?: string;
  backend?: string;
  concurrency?: string;
  resume?: string;
  background?: boolean;
}

interface ShowOptions extends StorageOptions {
  agent?: string;
  transcript?: boolean;
}

function storageRoot(options: StorageOptions): string {
  return resolve(
    options.runsDir ??
      join(resolve(options.cwd ?? process.cwd()), ".workflow/runs"),
  );
}

function launchIdentity(report: Report) {
  return {
    runId: report.runId,
    directory: report.directory,
    scriptPath: join(report.directory, "script.js"),
  };
}

async function configureRun(cwd: string, options: RunOptions) {
  const config = await loadConfig(cwd);
  if (options.backend) {
    config.backend = backendName.parse(options.backend);
  }

  if (options.model !== undefined) {
    config.defaults.model = z.string().trim().min(1).parse(options.model);
  }

  if (options.concurrency) {
    const value = Number(options.concurrency);
    if (!Number.isInteger(value) || value < 1 || value > 16) {
      throw new Error("Concurrency must be between 1 and 16");
    }

    config.concurrency = value;
  }

  return config;
}

async function loadRunArgs(root: string, options: RunOptions) {
  let args = jsonValue.parse(
    JSON.parse(
      options.argsFile
        ? await readFile(resolve(options.argsFile), "utf8")
        : (options.args ?? "null"),
    ),
  );

  if (options.resume) {
    const previous = await inspectReport(root, options.resume);
    if (previous.status === "running") {
      throw new Error(
        "Stop the previous run before resuming" +
          (previous.observation ? `: ${previous.observation}` : ""),
      );
    }

    if (options.args === undefined && !options.argsFile) {
      args = jsonValue.parse(
        JSON.parse(
          await readFile(
            join(runPath(root, options.resume), "args.json"),
            "utf8",
          ),
        ),
      );
    }
  }

  return args;
}

async function readWorkflowSource(path: string) {
  let source = "";
  if (path === "-") {
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      source += String(chunk);
    }
  } else {
    source = await readScriptFile(resolve(path));
  }

  return source;
}

const outputClosed = new AbortController();

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  // A closed consumer cancels owned work without turning a normal pipe into failure.
  if (error.code === "EPIPE") {
    outputClosed.abort(new Error("Output pipe closed"));
    process.exitCode = 0;
  } else if (!outputClosed.signal.aborted) {
    throw error;
  }
});

/** Prints the report of signal-cancellable work and sets the exit code from its status. */
async function withCancellableProgress(
  json: boolean,
  {
    signalReason,
    cancelledExitCode = 1,
  }: { signalReason: string; cancelledExitCode?: number },
  work: (signal: AbortSignal, progress: Progress) => Promise<Report>,
) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error(signalReason));
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const progress = new Progress(json);
  let report: Report;
  try {
    report = await work(
      AbortSignal.any([controller.signal, outputClosed.signal]),
      progress,
    );
  } finally {
    progress.close();
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }

  printReport(report, json);
  if (report.status !== "completed" && !outputClosed.signal.aborted) {
    process.exitCode = report.status === "cancelled" ? cancelledExitCode : 1;
  }
}

const program = new Command();

function storageCommand(
  name: string,
  cwd = "Working directory containing run storage",
): Command {
  return program
    .command(name)
    .option("--runs-dir <path>", "Run storage directory")
    .option("--cwd <directory>", cwd);
}

program
  .name("workflow-cli")
  .description(
    "Deterministic multi-agent workflows across coding agent harnesses",
  )
  .version(version);

program
  .command("info")
  .description(
    "Describe this installation, available backends and the script API",
  )
  .option("--json", "Print JSON")
  .action(async (options: { json?: boolean }) => {
    const info = await inspectInstallation(process.cwd());
    const output = options.json
      ? JSON.stringify(info, null, 2) + "\n"
      : formatInstallation(info);
    process.stdout.write(output);
  });

storageCommand("run", "Agent working directory")
  .description("Run a JavaScript workflow from a file, or - for stdin")
  .argument("<script>")
  .option("--background", "Return a run ID and continue in the background")
  .option("--args <json>", "JSON input")
  .option("--args-file <path>", "Read JSON input from a file")
  .option("--backend <name>", "Default backend")
  .option("--model <id>", "Default model (from workflow-cli info)")
  .option("--concurrency <count>", "Maximum concurrent agents (1–16)")
  .option("--resume <run-id>", "Replay unchanged calls from a stopped run")
  .option("--json", "Stream NDJSON events and a final report")
  .action(async (path: string, options: RunOptions) => {
    if (options.args !== undefined && options.argsFile !== undefined) {
      throw new Error("Use only one of --args and --args-file");
    }

    const cwd = resolve(options.cwd ?? process.cwd());
    const root = storageRoot(options);
    const config = await configureRun(cwd, options);
    const args = await loadRunArgs(root, options);
    const source = await readWorkflowSource(path);

    if (await firstRunNotice(root)) {
      process.stderr.write(notice + "\n");
    }

    const launch: Launch = {
      source,
      scriptPath: path === "-" ? join(cwd, "stdin.js") : resolve(path),
      args,
      cwd,
      root,
      config,
      resume: options.resume,
    };
    if (options.background) {
      const reply = await launchBackground(
        fileURLToPath(import.meta.url),
        launch,
      );

      process.stdout.write(
        options.json
          ? JSON.stringify(reply) + "\n"
          : `Started ${reply.runId}\nRun: ${reply.directory}\nScript: ${reply.scriptPath}\nUse workflow-cli wait ${reply.runId} --runs-dir ${root} for the result.\n`,
      );
      if (reply.warning && !options.json) {
        process.stderr.write(`${reply.warning}: ${reply.logsDirectory}\n`);
      }

      return;
    }

    await withCancellableProgress(
      !!options.json,
      { signalReason: "Cancelled by signal", cancelledExitCode: 130 },
      (signal, progress) =>
        runWorkflow({
          ...launch,
          drivers: createDrivers(config.transport),
          signal,
          onEvent: (event) => progress.event(event),
        }),
    );
  });

storageCommand("show")
  .description("Inspect a run or an individual agent")
  .argument("<run-id>")
  .option("--json", "Print JSON")
  .option("--agent <id>", "Inspect one agent")
  .option("--transcript", "Print the selected agent transcript")
  .action(async (id: string, options: ShowOptions) => {
    const root = storageRoot(options);
    const report = await inspectReport(root, id);
    if (options.transcript && !options.agent) {
      throw new Error("--transcript requires --agent");
    }

    if (!options.agent) {
      printReport(report, !!options.json, true);

      return;
    }

    const agent =
      report.agents.find((agent) => agent.id === Number(options.agent)) ??
      report.activeAgents.find((agent) => agent.id === Number(options.agent));
    if (!agent) {
      throw new Error(`Agent ${options.agent} does not exist in this run`);
    }

    if (options.transcript) {
      try {
        process.stdout.write(await readTranscript(root, id, agent.id));
      } catch (error) {
        if (
          isErrno(error, "ENOENT") &&
          (agent.status === "queued" || agent.status === "running")
        ) {
          process.stdout.write(
            "No backend transcript has arrived for this agent yet.\n",
          );
        } else {
          throw error;
        }
      }
    } else {
      process.stdout.write(JSON.stringify(agent, null, 2) + "\n");
    }
  });

storageCommand("journal")
  .description("Print the raw agent result journal")
  .argument("<run-id>")
  .action(async (id: string, options: StorageOptions) => {
    const path = join(runPath(storageRoot(options), id), "journal.jsonl");
    process.stdout.write(await readFile(path, "utf8"));
  });

storageCommand("stop")
  .description("Cancel a run and wait for its workers to finish shutting down")
  .argument("<run-id>")
  .option("--json", "Print the terminal report as JSON")
  .action(async (id: string, options: StorageOptions) => {
    const root = storageRoot(options);
    const before = await inspectReport(root, id);
    if (before.status === "running") {
      await controlRun(root, id, { action: "stop" });
    }

    const report = await waitForRun(root, id, new AbortController().signal);
    printReport(report, !!options.json);
  });

storageCommand("skip")
  .description("Skip one queued or running agent")
  .argument("<run-id>")
  .argument("<agent-id>")
  .option("--json", "Print JSON acknowledgement")
  .action(async (id: string, agent: string, options: StorageOptions) => {
    const index = Number(agent);
    if (!Number.isInteger(index) || index < 1) {
      throw new Error("Agent ID must be a positive integer");
    }

    await controlRun(storageRoot(options), id, { action: "skip", id: index });
    process.stdout.write(
      options.json
        ? JSON.stringify({ type: "skip-requested", runId: id, id: index }) +
            "\n"
        : `Skip requested for agent ${index} in ${id}.\n`,
    );
  });

storageCommand("wait")
  .description("Wait for a background run and print its result")
  .argument("<run-id>")
  .option("--json", "Stream progress and print the terminal report as JSON")
  .action(async (id: string, options: StorageOptions) => {
    await withCancellableProgress(
      !!options.json,
      {
        signalReason:
          "Stopped waiting; the workflow continues in the background",
      },
      (signal, progress) =>
        waitForRun(storageRoot(options), id, signal, (report) =>
          progress.observe(report),
        ),
    );
  });

program
  .command("__worker", { hidden: true })
  .argument("<launch-directory>")
  .action(async (directory: string) => {
    if (!process.send) {
      throw new Error("Internal worker requires a background launcher");
    }

    const startup = new AbortController();
    const cancelStartup = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "cancel-startup"
      ) {
        startup.abort(new Error("Background startup cancelled by launcher"));
      }
    };

    process.on("message", cancelStartup);
    try {
      const launch = await readLaunch(directory);
      let acknowledged = false;
      await withCancellableProgress(
        true,
        { signalReason: "Cancelled by signal" },
        async (signal, progress) => {
          const report = await runWorkflow({
            ...launch,
            drivers: createDrivers(launch.config.transport),
            signal: AbortSignal.any([signal, startup.signal]),
            onEvent: (event) => progress.event(event),
            onStarting: (run) =>
              notifyLauncher({
                type: "starting",
                ...launchIdentity(run.store.report),
              }),
            onReady: async (run) => {
              await notifyLauncher({
                type: "ready",
                ...launchIdentity(run.store.report),
              });
              acknowledged = true;
            },
          });

          if (!acknowledged) {
            await notifyLauncher({
              type: "failed",
              ...launchIdentity(report),
              error: report.error ?? "Workflow launch failed",
            });
          }

          return report;
        },
      );
    } finally {
      process.removeListener("message", cancelStartup);
      if (process.connected) {
        process.disconnect?.();
      }
    }
  });

program
  .command("skill")
  .description("Print or install the bundled workflow authoring skill")
  .option("--print", "Print to stdout")
  .option(
    "--install <directory>",
    "Install the bundled skill and references into a harness skill directory",
  )
  .action(async (options: { print?: boolean; install?: string }) => {
    if (!!options.print === !!options.install) {
      throw new Error("Choose --print or --install <directory>");
    }

    const source = fileURLToPath(
      new URL("../skills/workflow/", import.meta.url),
    );
    if (options.print) {
      process.stdout.write(await readFile(join(source, "SKILL.md"), "utf8"));
    } else if (options.install) {
      await cp(source, resolve(options.install), { recursive: true });
      process.stdout.write(
        `Installed workflow skill into ${resolve(options.install)}\n`,
      );
    }
  });

await program.parseAsync().catch((error) => {
  if (outputClosed.signal.aborted) {
    return;
  }

  process.stderr.write(`workflow-cli: ${errorText(error)}\n`);
  process.exitCode = 1;
});

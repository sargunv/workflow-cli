#!/usr/bin/env node
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import { z } from "zod";

import { launchBackground, readLaunch, notifyLauncher } from "./background.js";
import { loadConfig } from "./config.js";
import { createDrivers } from "./drivers/index.js";
import { notice, firstRunNotice } from "./notice.js";
import { Progress, printReport } from "./output.js";
import { controlRun, inspectReport } from "./runtime/control.js";
import { runWorkflow } from "./runtime/run.js";
import { readScriptFile } from "./runtime/script.js";
import { runPath } from "./runtime/store.js";
import { readTranscript } from "./runtime/transcript.js";
import { backendName, errorText, jsonValue } from "./types.js";
import { waitForRun } from "./wait.js";
const outputClosed = new AbortController();
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    outputClosed.abort(new Error("Output pipe closed"));
    process.exitCode = 0;
  } else if (!outputClosed.signal.aborted) throw error;
});
const program = new Command();
program
  .name("workflow")
  .description(
    "Deterministic multi-agent workflows across coding agent harnesses",
  )
  .version("0.1.0");
program
  .command("info")
  .description(
    "Describe this installation, available backends and the script API",
  )
  .option("--json", "Print JSON")
  .action(async (options: { json?: boolean }) => {
    const cwd = process.cwd(),
      config = await loadConfig(cwd),
      drivers = createDrivers(config.transport);
    const backends = await Promise.all(
      Object.values(drivers).map((driver) => driver.detect(cwd)),
    );
    const runtime = {
      scriptAPI: [
        "agent",
        "pipeline",
        "parallel",
        "phase",
        "log",
        "args",
        "budget",
        "workflow",
      ],
      concurrency: config.concurrency,
      agentCap: 1000,
      itemsPerCall: 4096,
      defaultBackend: config.backend,
      defaults: config.defaults,
      transport: config.transport,
      sandbox: config.sandbox,
      schemaStrategy: config.schemaStrategy,
      schemaRetries: config.schemaRetries,
      budget: { total: null, spent: 0, remaining: "Infinity" },
      notice,
    };
    if (options.json)
      process.stdout.write(
        JSON.stringify(
          { runtime, backends, profiles: config.profiles },
          null,
          2,
        ) + "\n",
      );
    else {
      process.stdout.write(
        `runtime\n  script API       ${runtime.scriptAPI.join(", ")}\n  concurrency      ${runtime.concurrency}\n  agent cap        1000 per run\n  items per call   4096\n  default backend  ${config.backend}\n  defaults         ${JSON.stringify(config.defaults)}\n  budget           disabled (total: null)\n  sandbox          ${config.sandbox.memoryBytes} bytes, ${config.sandbox.instructions} interrupt checks, 512 KiB stack\n  schema strategy  ${config.schemaStrategy}, ${config.schemaRetries} correction attempts\n  agent timeout    ${config.transport.agentTimeoutMs}ms per attempt\n  discovery timeout ${config.transport.discoveryTimeoutMs}ms\n  launch timeout   ${config.transport.launchTimeoutMs}ms\n\n${notice}\n\nbackends\n`,
      );
      for (const backend of backends) {
        process.stdout.write(
          `  ${backend.name.padEnd(10)} ${backend.available ? "available" : "missing"}  ${backend.version ?? ""}  ${backend.binary ?? ""}\n    transport ${backend.transport}; structured ${backend.structured}; correction ${backend.correction}; worktree ${backend.worktree ? "yes" : "no"}; tool policies ${backend.toolPolicies.join(", ") || "none"}; minimal ${backend.minimal}; usage ${backend.usage ? "reported" : "unavailable"}\n`,
        );
        if (backend.models.length)
          process.stdout.write(
            `    models ${backend.models.map((model) => `${model.id}${model.default ? " (default)" : ""}${model.efforts.length ? " [" + model.efforts.join(",") + "]" : ""}`).join(", ")}\n`,
          );
        for (const note of backend.notes) process.stdout.write(`    ${note}\n`);
      }
      process.stdout.write(
        `\nprofiles\n${
          Object.entries(config.profiles)
            .map(([name, profile]) => `  ${name}  ${JSON.stringify(profile)}`)
            .join("\n") || "  none"
        }\n`,
      );
    }
  });
interface RunOptions {
  model?: string;
  args?: string;
  argsFile?: string;
  backend?: string;
  concurrency?: string;
  resume?: string;
  json?: boolean;
  runsDir?: string;
  cwd?: string;
  background?: boolean;
}
program
  .command("run")
  .description("Run a JavaScript workflow from a file, or - for stdin")
  .argument("<script>")
  .option("--background", "Return a run ID and continue in the background")
  .option("--args <json>", "JSON input")
  .option("--args-file <path>", "Read JSON input from a file")
  .option("--backend <name>", "Default backend")
  .option("--model <id>", "Default model (from workflow info)")
  .option("--concurrency <count>", "Maximum concurrent leaf agents (1–16)")
  .option("--resume <run-id>", "Replay unchanged calls from a stopped run")
  .option("--json", "Stream NDJSON events and a final report")
  .option("--runs-dir <path>", "Run storage directory")
  .option("--cwd <directory>", "Agent working directory")
  .action(async (path: string, options: RunOptions) => {
    if (options.args !== undefined && options.argsFile !== undefined)
      throw new Error("Use only one of --args and --args-file");
    const cwd = resolve(options.cwd ?? process.cwd()),
      root = resolve(options.runsDir ?? join(cwd, ".workflow", "runs"));
    const config = await loadConfig(cwd);
    if (options.backend) config.backend = backendName.parse(options.backend);
    if (options.model !== undefined)
      config.defaults.model = z.string().trim().min(1).parse(options.model);
    if (options.concurrency) {
      const value = Number(options.concurrency);
      if (!Number.isInteger(value) || value < 1 || value > 16)
        throw new Error("Concurrency must be between 1 and 16");
      config.concurrency = value;
    }
    let args = jsonValue.parse(
      JSON.parse(
        options.argsFile
          ? await readFile(resolve(options.argsFile), "utf8")
          : (options.args ?? "null"),
      ),
    );
    if (options.resume) {
      const previous = await inspectReport(root, options.resume);
      if (previous.status === "running")
        throw new Error(
          "Stop the previous run before resuming" +
            (previous.observation ? `: ${previous.observation}` : ""),
        );
      if (options.args === undefined && !options.argsFile)
        args = jsonValue.parse(
          JSON.parse(
            await readFile(
              join(runPath(root, options.resume), "args.json"),
              "utf8",
            ),
          ),
        );
    }
    let source = "";
    if (path === "-") {
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) source += String(chunk);
    } else source = await readScriptFile(resolve(path));
    if (await firstRunNotice(root)) process.stderr.write(notice + "\n");
    if (options.background) {
      const reply = await launchBackground(fileURLToPath(import.meta.url), {
        source,
        scriptPath: path === "-" ? join(cwd, "stdin.js") : resolve(path),
        args,
        cwd,
        root,
        config,
        resume: options.resume,
      });
      process.stdout.write(
        options.json
          ? JSON.stringify(reply) + "\n"
          : `Started ${reply.runId}\nRun: ${reply.directory}\nScript: ${reply.scriptPath}\nUse workflow wait ${reply.runId} --runs-dir ${root} for the result.\n`,
      );
      if (reply.warning && !options.json)
        process.stderr.write(`${reply.warning}: ${reply.logsDirectory}\n`);
      return;
    }
    const progress = new Progress(!!options.json),
      controller = new AbortController();
    const cancel = () => controller.abort(new Error("Cancelled by signal"));
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);

    try {
      const report = await runWorkflow({
        source,
        scriptPath: path === "-" ? join(cwd, "stdin.js") : resolve(path),
        args,
        cwd,
        root,
        config,
        drivers: createDrivers(config.transport),
        resume: options.resume,
        signal: AbortSignal.any([controller.signal, outputClosed.signal]),
        onEvent: (event) => progress.event(event),
      });
      progress.close();
      printReport(report, !!options.json);
      if (report.status !== "completed" && !outputClosed.signal.aborted)
        process.exitCode = report.status === "cancelled" ? 130 : 1;
    } finally {
      progress.close();
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  });
interface ShowOptions {
  json?: boolean;
  agent?: string;
  transcript?: boolean;
  runsDir?: string;
  cwd?: string;
}
program
  .command("show")
  .description("Inspect a run or an individual agent")
  .argument("<run-id>")
  .option("--json", "Print JSON")
  .option("--agent <id>", "Inspect one agent")
  .option("--transcript", "Print the selected agent transcript")
  .option("--runs-dir <path>", "Run storage directory")
  .option("--cwd <directory>", "Working directory containing run storage")
  .action(async (id: string, options: ShowOptions) => {
    const root = resolve(
        options.runsDir ??
          join(resolve(options.cwd ?? process.cwd()), ".workflow/runs"),
      ),
      report = await inspectReport(root, id);
    if (options.transcript && !options.agent)
      throw new Error("--transcript requires --agent");
    if (!options.agent) {
      printReport(report, !!options.json, true);
      return;
    }
    const agent =
      report.agents.find((agent) => agent.id === Number(options.agent)) ??
      report.activeAgents.find((agent) => agent.id === Number(options.agent));
    if (!agent)
      throw new Error(`Agent ${options.agent} does not exist in this run`);
    if (options.transcript) {
      try {
        process.stdout.write(await readTranscript(root, id, agent.id));
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT" &&
          (agent.status === "queued" || agent.status === "running")
        )
          process.stdout.write(
            "No backend transcript has arrived for this agent yet.\n",
          );
        else throw error;
      }
    } else process.stdout.write(JSON.stringify(agent, null, 2) + "\n");
  });
program
  .command("journal")
  .description("Print the raw agent result journal")
  .argument("<run-id>")
  .option("--runs-dir <path>", "Run storage directory")
  .option("--cwd <directory>", "Working directory containing run storage")
  .action(async (id: string, options: { runsDir?: string; cwd?: string }) => {
    process.stdout.write(
      await readFile(
        join(
          runPath(
            resolve(
              options.runsDir ??
                join(resolve(options.cwd ?? process.cwd()), ".workflow/runs"),
            ),
            id,
          ),
          "journal.jsonl",
        ),
        "utf8",
      ),
    );
  });
interface InspectOptions {
  runsDir?: string;
  cwd?: string;
  json?: boolean;
}
function storageRoot(options: InspectOptions): string {
  return resolve(
    options.runsDir ??
      join(resolve(options.cwd ?? process.cwd()), ".workflow/runs"),
  );
}
program
  .command("stop")
  .description("Cancel a run and wait for its workers to finish shutting down")
  .argument("<run-id>")
  .option("--runs-dir <path>", "Run storage directory")
  .option("--cwd <directory>", "Working directory containing run storage")
  .option("--json", "Print the terminal report as JSON")
  .action(async (id: string, options: InspectOptions) => {
    const root = storageRoot(options);
    const before = await inspectReport(root, id);
    if (before.status === "running")
      await controlRun(root, id, { action: "stop" });
    const report = await waitForRun(root, id, new AbortController().signal);
    printReport(report, !!options.json);
  });
program
  .command("skip")
  .description("Skip one queued or running agent")
  .argument("<run-id>")
  .argument("<agent-id>")
  .option("--runs-dir <path>", "Run storage directory")
  .option("--cwd <directory>", "Working directory containing run storage")
  .option("--json", "Print JSON acknowledgement")
  .action(async (id: string, agent: string, options: InspectOptions) => {
    const index = Number(agent);
    if (!Number.isInteger(index) || index < 1)
      throw new Error("Agent ID must be a positive integer");
    await controlRun(storageRoot(options), id, { action: "skip", id: index });
    process.stdout.write(
      options.json
        ? JSON.stringify({ type: "skip-requested", runId: id, id: index }) +
            "\n"
        : `Skip requested for agent ${index} in ${id}.\n`,
    );
  });
program
  .command("wait")
  .description("Wait for a background run and print its result")
  .argument("<run-id>")
  .option("--runs-dir <path>", "Run storage directory")
  .option("--cwd <directory>", "Working directory containing run storage")
  .option("--json", "Stream progress and print the terminal report as JSON")
  .action(async (id: string, options: InspectOptions) => {
    const controller = new AbortController();
    const interrupt = () =>
      controller.abort(
        new Error("Stopped waiting; the workflow continues in the background"),
      );
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    const progress = new Progress(!!options.json);
    try {
      const report = await waitForRun(
        storageRoot(options),
        id,
        AbortSignal.any([controller.signal, outputClosed.signal]),
        (report) => progress.observe(report),
      );
      progress.close();
      printReport(report, !!options.json);
      if (report.status !== "completed" && !outputClosed.signal.aborted)
        process.exitCode = 1;
    } finally {
      progress.close();
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  });
program
  .command("__worker", { hidden: true })
  .argument("<launch-directory>")
  .action(async (directory: string) => {
    if (!process.send)
      throw new Error("Internal worker requires a background launcher");
    const controller = new AbortController();
    const cancelStartup = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "cancel-startup"
      )
        controller.abort(new Error("Background startup cancelled by launcher"));
    };
    process.on("message", cancelStartup);
    const launch = await readLaunch(directory);
    const cancel = () => controller.abort(new Error("Cancelled by signal"));
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    const progress = new Progress(true);
    let acknowledged = false;
    try {
      const report = await runWorkflow({
        ...launch,
        drivers: createDrivers(launch.config.transport),
        signal: AbortSignal.any([controller.signal, outputClosed.signal]),
        onEvent: (event) => progress.event(event),
        onStarting: (run) =>
          notifyLauncher({
            type: "starting",
            runId: run.store.report.runId,
            directory: run.store.directory,
            scriptPath: join(run.store.directory, "script.js"),
          }),
        onReady: async (run) => {
          await notifyLauncher({
            type: "ready",
            runId: run.store.report.runId,
            directory: run.store.directory,
            scriptPath: join(run.store.directory, "script.js"),
          });
          acknowledged = true;
        },
      });
      if (!acknowledged)
        await notifyLauncher({
          type: "failed",
          runId: report.runId,
          directory: report.directory,
          scriptPath: join(report.directory, "script.js"),
          error: report.error ?? "Workflow launch failed",
        });
      printReport(report, true);
      if (report.status !== "completed" && !outputClosed.signal.aborted)
        process.exitCode = 1;
    } finally {
      progress.close();
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
      process.removeListener("message", cancelStartup);
      if (process.connected) process.disconnect?.();
    }
  });
program
  .command("skill")
  .description("Print or install the bundled workflow authoring skill")
  .option("--print", "Print to stdout")
  .option(
    "--install <directory>",
    "Install SKILL.md into a harness skill directory",
  )
  .action(async (options: { print?: boolean; install?: string }) => {
    if (!!options.print === !!options.install)
      throw new Error("Choose --print or --install <directory>");
    const source = fileURLToPath(
      new URL("../skills/workflow/SKILL.md", import.meta.url),
    );
    if (options.print) process.stdout.write(await readFile(source, "utf8"));
    else if (options.install) {
      await mkdir(resolve(options.install), { recursive: true });
      await copyFile(source, join(resolve(options.install), "SKILL.md"));
      process.stdout.write(
        `Installed ${join(resolve(options.install), "SKILL.md")}\n`,
      );
    }
  });
await program.parseAsync().catch((error) => {
  if (outputClosed.signal.aborted) return;
  process.stderr.write(`workflow: ${errorText(error)}\n`);
  process.exitCode = 1;
});

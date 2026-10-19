import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { inspectReport } from "../../src/runtime/control.js";
import { installFake, tempDir, waitFor } from "./common.js";

const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

/** A project whose PATH holds only the fake Claude CLI and Node. */
export async function project(body: string, config?: object) {
  const cwd = await tempDir("cli");
  await mkdir(join(cwd, "bin"));
  await installFake(join(cwd, "bin"), "fake-claude", "claude");
  const script = join(cwd, "main.js");
  await writeFile(
    script,
    "export const meta={name:'cli-test',description:'CLI subprocess test'};\n" +
      body,
  );
  if (config) {
    await mkdir(join(cwd, ".workflow"));
    await writeFile(
      join(cwd, ".workflow", "config.json"),
      JSON.stringify(config),
    );
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [join(cwd, "bin"), dirname(process.execPath)].join(delimiter),
    XDG_CONFIG_HOME: join(cwd, "config"),
    WORKFLOW_FIXTURE_CALLS: join(cwd, "calls"),
  };
  return { cwd, root: join(cwd, ".workflow", "runs"), script, env };
}

export type Project = Awaited<ReturnType<typeof project>>;

export function spawnCli(args: string[], p: Project) {
  return spawn(process.execPath, [...process.execArgv, cli, ...args], {
    cwd: p.cwd,
    env: p.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function command(args: string[], p: Project) {
  const child = spawnCli(args, p);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

// The parts of `--json` output that calling agents rely on.
export const launched = z.object({
  type: z.literal("ready"),
  runId: z.string(),
  directory: z.string(),
});

const finalReport = z.object({
  runId: z.string(),
  status: z.enum(["completed", "failed", "cancelled", "interrupted"]),
  result: z.unknown(),
  counts: z.object({
    done: z.number(),
    errored: z.number(),
    skipped: z.number(),
    cached: z.number(),
  }),
  tokens: z.object({ input: z.number(), output: z.number() }),
  directory: z.string(),
  logs: z.array(z.string()),
  error: z.string().optional(),
  usageLimit: z
    .object({
      backend: z.string(),
      agentId: z.number(),
      message: z.string(),
      limit: z.string().optional(),
      resetsAt: z.string().optional(),
    })
    .optional(),
});

/** Parses the final NDJSON line of a `--json` run, wait or stop. */
export function final(stdout: string) {
  return finalReport.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? ""));
}

export async function onlyRunId(p: Project) {
  const ids = (await readdir(p.root)).filter((id) => id.startsWith("wf_"));
  assert.equal(ids.length, 1);
  return ids[0] ?? "";
}

export function runningAgents(p: Project, id: string, count: number) {
  return waitFor(async () => {
    const report = await inspectReport(p.root, id);
    if (report.status !== "running") {
      throw new Error(report.error ?? "Run finished too early");
    }
    const running = report.activeAgents.filter((a) => a.status === "running");
    return running.length === count ? report : undefined;
  }, `${count} running agents`);
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { inspectReport, controlRun } from "../src/runtime/control.js";
import { waitForRun } from "../src/wait.js";
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const header =
  "export const meta={name:'cli-test',description:'CLI subprocess test'};\n";
async function fixture(body: string) {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-cli-"));
  await mkdir(join(cwd, "bin"));
  await copyFile(
    new URL("./helpers/fake-claude.cjs", import.meta.url),
    join(cwd, "bin", "claude"),
  );
  await chmod(join(cwd, "bin", "claude"), 0o755);
  const script = join(cwd, "main.js");
  await writeFile(script, header + body);
  const root = join(cwd, ".workflow", "runs");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [join(cwd, "bin"), dirname(process.execPath)].join(delimiter),
    XDG_CONFIG_HOME: join(cwd, "config"),
    WORKFLOW_FIXTURE_CALLS: join(cwd, "calls"),
  };
  return { cwd, root, script, env };
}
async function command(
  args: string[],
  context: Awaited<ReturnType<typeof fixture>>,
) {
  const child = spawn(process.execPath, [...process.execArgv, cli, ...args], {
    cwd: context.cwd,
    env: context.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
const ready = z.object({
  type: z.literal("ready"),
  runId: z.string(),
  directory: z.string(),
});

void test("skill installation includes linked references and updates bundled files", async (t) => {
  const f = await fixture("");
  t.after(() => rm(f.cwd, { recursive: true, force: true }));
  const destination = join(f.cwd, "skills", "workflow");
  const source = fileURLToPath(new URL("../skills/workflow/", import.meta.url));

  const installed = await command(["skill", "--install", destination], f);
  assert.equal(installed.code, 0, installed.stderr);
  for (const path of [
    "SKILL.md",
    "references/claude.md",
    "references/gpt.md",
  ]) {
    assert.equal(
      await readFile(join(destination, path), "utf8"),
      await readFile(join(source, path), "utf8"),
    );
  }

  await writeFile(join(destination, "SKILL.md"), "old entrypoint");
  await writeFile(join(destination, "references", "claude.md"), "old guide");
  await writeFile(join(destination, "references", "local.md"), "local notes");
  const updated = await command(["skill", "--install", destination], f);
  assert.equal(updated.code, 0, updated.stderr);
  assert.equal(
    await readFile(join(destination, "references", "claude.md"), "utf8"),
    await readFile(join(source, "references", "claude.md"), "utf8"),
  );
  assert.equal(
    await readFile(join(destination, "references", "local.md"), "utf8"),
    "local notes",
  );

  const printed = await command(["skill", "--print"], f);
  assert.equal(printed.code, 0, printed.stderr);
  assert.equal(
    printed.stdout,
    await readFile(join(source, "SKILL.md"), "utf8"),
  );
  assert.equal(
    await readFile(join(destination, "SKILL.md"), "utf8"),
    printed.stdout,
  );
});

void test("CLI reports quota details and resume retries the interrupted leaf", async () => {
  const f = await fixture(
    "await agent('seed'); try { const result=await agent('limited'); if(result===null) log('dropped work'); } catch(e) { log('caught'); } return agent('after');",
  );
  f.env.WORKFLOW_FIXTURE_USAGE_LIMIT = fileURLToPath(
    new URL("./fixtures/claude-usage-limit.jsonl", import.meta.url),
  );
  const stopped = await command(["run", f.script, "--json"], f);
  assert.equal(stopped.code, 130, stopped.stderr);
  const final = JSON.parse(stopped.stdout.trim().split("\n").at(-1) ?? "null");
  assert.equal(final.status, "cancelled");
  assert.deepEqual(final.logs, []);
  assert.equal(final.usageLimit.backend, "claude");
  assert.equal(final.usageLimit.limit, "seven_day_opus");
  assert.equal(final.usageLimit.resetsAt, "2026-10-13T00:00:00.000Z");
  const shown = await command(["show", final.runId], f);
  assert.match(shown.stdout, /claude usage limit.*seven_day_opus.*2026-10-13/);

  delete f.env.WORKFLOW_FIXTURE_USAGE_LIMIT;
  const resumed = await command(
    ["run", f.script, "--resume", final.runId, "--json"],
    f,
  );
  assert.equal(resumed.code, 0, resumed.stderr);
  const completed = JSON.parse(
    resumed.stdout.trim().split("\n").at(-1) ?? "null",
  );
  assert.equal(completed.result, "after");
  assert.equal(completed.counts.cached, 1);
  assert.equal(
    await readFile(join(f.cwd, "calls"), "utf8"),
    "seed\nlimited\nlimited\nafter\n",
  );
});

async function waitActive(root: string, id: string, count: number) {
  // CI workers may still be cold-loading QuickJS and fixture processes after readiness.
  const deadline = performance.now() + 10_000;
  let observed = "no report";
  while (performance.now() < deadline) {
    const report = await inspectReport(root, id);
    observed = JSON.stringify(
      report.activeAgents.map(({ id, status }) => ({ id, status })),
    );
    if (
      report.activeAgents.filter((agent) => agent.status === "running")
        .length === count
    ) {
      return report;
    }
    if (report.status !== "running") {
      throw Error(report.error ?? "Run finished too early");
    }
    await setTimeout(25);
  }
  throw Error(
    `Expected ${count} running agents within 10s; last observed: ${observed}`,
  );
}
void test("background skip and stop control the exact run; show includes active prompts", async () => {
  const f = await fixture(
    "return parallel([()=>agent('block first'),()=>agent('block second')]);",
  );
  // Model a small CI runner; the test needs two concurrent blocked agents.
  await mkdir(join(f.cwd, ".workflow"));
  await writeFile(
    join(f.cwd, ".workflow", "config.json"),
    JSON.stringify({ concurrency: 1 }),
  );
  const launched = await command(
    ["run", f.script, "--background", "--json", "--concurrency", "2"],
    f,
  );
  assert.equal(launched.code, 0, launched.stderr);
  const run = ready.parse(JSON.parse(launched.stdout));
  try {
    await waitActive(f.root, run.runId, 2);
    const show = await command(
      ["show", run.runId, "--agent", "1", "--json"],
      f,
    );
    assert.equal(show.code, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout).prompt, "block first");
    const skip = await command(["skip", run.runId, "1", "--json"], f);
    assert.equal(skip.code, 0, skip.stderr);
    for (let i = 0; i < 100; i++) {
      if (
        (await inspectReport(f.root, run.runId)).agents.some(
          (agent) => agent.id === 1,
        )
      ) {
        break;
      }
      await setTimeout(20);
    }
    const current = await inspectReport(f.root, run.runId);
    assert.equal(
      current.agents.find((agent) => agent.id === 1)?.status,
      "skipped",
    );
    assert.equal(current.status, "running");
    const stop = await command(["stop", run.runId, "--json"], f);
    assert.equal(stop.code, 0, stop.stderr);
    const stopped = z
      .object({ status: z.literal("cancelled") })
      .parse(JSON.parse(stop.stdout));
    assert.equal(stopped.status, "cancelled");
    assert.equal(
      (await inspectReport(f.root, run.runId)).activeAgents.length,
      0,
    );
    await assert.rejects(controlRun(f.root, run.runId, { action: "ping" }));
    assert.match(
      await readFile(join(run.directory, "stdout.log"), "utf8"),
      /agent-queued/,
    );
  } finally {
    const report = await inspectReport(f.root, run.runId);
    if (report.status === "running") {
      await controlRun(f.root, run.runId, { action: "stop" });
      await waitForRun(f.root, run.runId, new AbortController().signal);
    }
  }
});
void test("background completion, wait, cached resume and launch failures are observable", async () => {
  const f = await fixture("return agent('hello fixture');");
  const launched = await command(
    ["run", f.script, "--background", "--json"],
    f,
  );
  assert.equal(launched.code, 0, launched.stderr);
  const run = ready.parse(JSON.parse(launched.stdout));
  const waited = await command(["wait", run.runId, "--json"], f);
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(
    JSON.parse(waited.stdout.trim().split("\n").at(-1) ?? "null").result,
    "hello fixture",
  );
  const resumed = await command(
    ["run", f.script, "--resume", run.runId, "--json"],
    f,
  );
  assert.equal(resumed.code, 0, resumed.stderr);
  const final = JSON.parse(resumed.stdout.trim().split("\n").at(-1) ?? "null");
  assert.equal(final.counts.cached, 1);
  const cachedTranscript = await command(
    ["show", final.runId, "--agent", "1", "--transcript"],
    f,
  );
  assert.equal(cachedTranscript.code, 0, cachedTranscript.stderr);
  assert.match(cachedTranscript.stdout, /cache-hit/);
  assert.match(cachedTranscript.stdout, /read-1/);
  assert.equal(await readFile(join(f.cwd, "calls"), "utf8"), "hello fixture\n");
  const bad = await command(
    ["run", f.script, "--backend", "codex", "--background", "--json"],
    f,
  );
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unavailable/);
  assert.match(bad.stderr, /Run: wf_/);
});

void test("terminal persistence failure closes control and cannot leave stop hanging", async () => {
  const f = await fixture("return agent('block persistence');");
  const launched = await command(
    ["run", f.script, "--background", "--json"],
    f,
  );
  assert.equal(launched.code, 0, launched.stderr);
  const run = ready.parse(JSON.parse(launched.stdout));
  await waitActive(f.root, run.runId, 1);
  await mkdir(join(run.directory, "report.json.tmp"));
  await controlRun(f.root, run.runId, { action: "stop" });
  const report = await waitForRun(f.root, run.runId, AbortSignal.timeout(5000));
  assert.equal(report.status, "interrupted");
  await assert.rejects(controlRun(f.root, run.runId, { action: "ping" }));
});
void test("startup log relocation failure still returns the running identity", async () => {
  const f = await fixture("return agent('block relocate');");
  f.env = { ...f.env, WORKFLOW_FIXTURE_DISCOVERY_DELAY: "400" };
  const launching = command(["run", f.script, "--background", "--json"], f);
  let runDir = "";
  for (let i = 0; i < 100; i++) {
    const entries = await readdir(f.root).catch(() => []);
    const id = entries.find((entry) => entry.startsWith("wf_"));
    if (id) {
      runDir = join(f.root, id);
      await mkdir(join(runDir, "stdout.log"));
      break;
    }
    await setTimeout(10);
  }
  assert.ok(runDir);
  const launched = await launching;
  assert.equal(launched.code, 0, launched.stderr);
  const run = ready
    .extend({ warning: z.string(), logsDirectory: z.string() })
    .parse(JSON.parse(launched.stdout));
  try {
    await waitActive(f.root, run.runId, 1);
    assert.match(run.warning, /logs/);
  } finally {
    await controlRun(f.root, run.runId, { action: "stop" });
    await waitForRun(f.root, run.runId, AbortSignal.timeout(5000));
  }
});
void test("startup deadline cancels discovery and never starts leaf work", async () => {
  const f = await fixture("return agent('must not start');");
  f.env = { ...f.env, WORKFLOW_FIXTURE_DISCOVERY_DELAY: "5000" };
  await mkdir(join(f.cwd, ".workflow"), { recursive: true });
  await writeFile(
    join(f.cwd, ".workflow", "config.json"),
    JSON.stringify({
      transport: { launchTimeoutMs: 500, discoveryTimeoutMs: 10_000 },
    }),
  );
  const started = Date.now();
  const launched = await command(
    ["run", f.script, "--background", "--json"],
    f,
  );
  assert.equal(launched.code, 1);
  assert.match(launched.stderr, /timed out/);
  assert.ok(Date.now() - started < 4000);
  await assert.rejects(readFile(join(f.cwd, "calls"), "utf8"));
  const id = (await readdir(f.root)).find((entry) => entry.startsWith("wf_"));
  assert.ok(id);
  assert.notEqual((await inspectReport(f.root, id)).status, "running");
});
void test("nonregular child scripts fail before readiness rather than blocking startup", async () => {
  const f = await fixture("return workflow('./child.js');");
  // /usr/bin/mkfifo is an OS utility, not a vendor process.
  const fifo = spawn("/usr/bin/mkfifo", [join(f.cwd, "child.js")]);
  await new Promise<void>((resolve, reject) => {
    fifo.once("error", reject);
    fifo.once("close", (code) =>
      code === 0 ? resolve() : reject(Error("mkfifo failed")),
    );
  });
  const launched = await command(
    ["run", f.script, "--background", "--json"],
    f,
  );
  assert.equal(launched.code, 1);
  assert.match(launched.stderr, /regular file/);
});

void test("forced startup cancellation reaps discovery when its worker is suspended", async () => {
  const f = await fixture("return agent('must not start');");
  const pidFile = join(f.cwd, "discovery.json");
  f.env = {
    ...f.env,
    WORKFLOW_FIXTURE_DISCOVERY_DELAY: "20000",
    WORKFLOW_FIXTURE_DISCOVERY_PID: pidFile,
  };
  await mkdir(join(f.cwd, ".workflow"), { recursive: true });
  await writeFile(
    join(f.cwd, ".workflow", "config.json"),
    JSON.stringify({
      transport: { launchTimeoutMs: 1000, discoveryTimeoutMs: 30000 },
    }),
  );
  const launching = command(["run", f.script, "--background", "--json"], f);
  let discovery: { pid: number; supervisor: number } | undefined;
  let workerPid: number | undefined;
  const exists = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    for (let i = 0; i < 150; i++) {
      const data = await readFile(pidFile, "utf8").catch(() => undefined);
      if (data) {
        discovery = JSON.parse(data);
        break;
      }
      await setTimeout(10);
    }
    assert.ok(discovery, "discovery must start before the launch deadline");
    const id = (await readdir(f.root)).find((entry) => entry.startsWith("wf_"));
    assert.ok(id);
    workerPid = (await inspectReport(f.root, id)).pid;
    process.kill(workerPid, "SIGSTOP");
    const launched = await launching;
    assert.equal(launched.code, 1);
    assert.match(launched.stderr, /timed out/);
    for (let i = 0; i < 100 && exists(discovery.pid); i++) {
      await setTimeout(20);
    }
    assert.equal(
      exists(discovery.pid),
      false,
      "backend must exit with its owner",
    );
    assert.equal(exists(workerPid), false);
    assert.notEqual((await inspectReport(f.root, id)).status, "running");
    await assert.rejects(readFile(join(f.cwd, "calls"), "utf8"));
  } finally {
    if (workerPid && exists(workerPid)) {
      process.kill(workerPid, "SIGKILL");
    }
    if (discovery && exists(discovery.supervisor)) {
      process.kill(-discovery.supervisor, "SIGKILL");
    }
    await launching;
  }
});

void test("run model flag sets the recorded default and rejects empty selection", async () => {
  const f = await fixture("return agent('model fixture');");
  const run = await command(
    ["run", f.script, "--model", "fixture-model", "--json"],
    f,
  );
  assert.equal(run.code, 0, run.stderr);
  const final = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null");
  const report = await inspectReport(f.root, final.runId);
  assert.equal(report.agents[0]?.options.model, "fixture-model");
  const invalid = await command(["run", f.script, "--model", "", "--json"], f);
  assert.equal(invalid.code, 1);
});

void test("a closed stdout pipe is quiet and cancels owned foreground work", async () => {
  const f = await fixture("return agent('block closed pipe');");
  const child = spawn(
    process.execPath,
    [...process.execArgv, cli, "run", f.script, "--json"],
    {
      cwd: f.cwd,
      env: f.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdout.destroy();
  const code = await closed;
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /EPIPE|Unhandled|node:events/);
  const ids = (await readdir(f.root)).filter((id) => id.startsWith("wf_"));
  assert.equal(ids.length, 1);
  const report = await inspectReport(f.root, ids[0] ?? "");
  assert.equal(report.status, "cancelled");
  await assert.rejects(controlRun(f.root, report.runId, { action: "ping" }));
});

void test("info exposes the same capabilities in JSON and human output", async () => {
  const f = await fixture("return null;");
  const json = await command(["info", "--json"], f);
  assert.equal(json.code, 0, json.stderr);
  const info = z
    .object({
      runtime: z.object({
        defaultBackend: z.literal("claude"),
        concurrency: z.number(),
      }),
      backends: z.array(
        z.object({
          name: z.string(),
          available: z.boolean(),
          transport: z.string(),
          models: z.array(
            z.object({
              id: z.string(),
              default: z.boolean().optional(),
              efforts: z.array(z.string()),
            }),
          ),
          notes: z.array(z.string()),
        }),
      ),
      profiles: z.record(z.string(), z.unknown()),
    })
    .parse(JSON.parse(json.stdout));
  assert.equal(info.backends.length, 6);
  assert.deepEqual(
    info.backends
      .filter((backend) => backend.available)
      .map((backend) => backend.name),
    ["claude"],
  );
  const claude = info.backends.find((backend) => backend.name === "claude");
  assert.ok(claude);
  assert.equal(claude.transport, "cli");
  assert.deepEqual(claude.models, [
    { id: "fable", efforts: [] },
    { id: "opus", efforts: [] },
    { id: "sonnet", efforts: [] },
    { id: "haiku", efforts: [] },
  ]);
  assert.match(claude.notes.join("\n"), /Static, non-exhaustive model aliases/);
  assert.match(claude.notes.join("\n"), /Any model ID accepted by claude/);
  assert.match(
    claude.notes.join("\n"),
    /Omit model to use Claude's configured default/,
  );
  assert.deepEqual(info.profiles, {});

  const human = await command(["info"], f);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /concurrency\s+\d+/);
  assert.match(human.stdout, /claude\s+available/);
  assert.match(human.stdout, /qwen\s+missing/);
  assert.match(
    human.stdout,
    /transport cli; structured native; correction turn/,
  );
  assert.match(human.stdout, /models fable, opus, sonnet, haiku/);
  for (const note of claude.notes) {
    assert.ok(human.stdout.includes(note));
  }
  assert.match(human.stdout, /profiles\n  none/);
});

void test("Claude passes aliases and unlisted model IDs to the harness unchanged", async () => {
  const models = [
    "opus",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "provider/custom-deployment",
  ];
  const f = await fixture(
    `return parallel(${JSON.stringify(models)}.map(model => () => agent('model test', {model})));`,
  );
  const argvLog = join(f.cwd, "argv.jsonl");
  f.env.WORKFLOW_FIXTURE_ARGV = argvLog;

  const run = await command(["run", f.script, "--json"], f);
  assert.equal(run.code, 0, run.stderr);
  const final = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null");
  assert.deepEqual(
    final.result,
    models.map(() => "model test"),
  );
  const invocations: string[][] = (await readFile(argvLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(invocations.length, models.length);
  assert.deepEqual(
    new Set(invocations.map((argv) => argv[argv.indexOf("--model") + 1])),
    new Set(models),
  );
});

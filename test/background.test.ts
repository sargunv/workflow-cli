import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { z } from "zod";

import { controlRun, inspectReport } from "../src/runtime/control.ts";
import { waitForRun } from "../src/wait.ts";
import {
  command,
  final,
  launched,
  onlyRunId,
  project,
  runningAgents,
} from "./helpers/cli.ts";
import { alive, exited, waitFor } from "./helpers/common.ts";

void test("background skip and stop control the exact run; show includes active prompts", async () => {
  // The flag overrides a config that would leave only one agent running.
  const p = await project(
    "return parallel([()=>agent('block first'),()=>agent('block second')]);",
    { concurrency: 1 },
  );
  const launch = await command(
    ["run", p.script, "--background", "--json", "--concurrency", "2"],
    p,
  );
  assert.equal(launch.code, 0, launch.stderr);
  const run = launched.parse(JSON.parse(launch.stdout));
  try {
    await runningAgents(p, run.runId, 2);
    const show = await command(
      ["show", run.runId, "--agent", "1", "--json"],
      p,
    );
    assert.equal(JSON.parse(show.stdout).prompt, "block first");

    const skip = await command(["skip", run.runId, "1", "--json"], p);
    assert.equal(skip.code, 0, skip.stderr);
    const afterSkip = await waitFor(async () => {
      const report = await inspectReport(p.root, run.runId);
      return report.agents.some((agent) => agent.id === 1) ? report : undefined;
    }, "the skipped agent's record");
    assert.equal(afterSkip.agents[0]?.status, "skipped");
    assert.equal(afterSkip.status, "running");

    const stop = await command(["stop", run.runId, "--json"], p);
    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(final(stop.stdout).status, "cancelled");
    await assert.rejects(controlRun(p.root, run.runId, { action: "ping" }));
    // A stopped run must not keep presenting its leaves as running.
    assert.deepEqual((await inspectReport(p.root, run.runId)).activeAgents, []);
    assert.match(
      await readFile(join(run.directory, "stdout.log"), "utf8"),
      /agent-queued/,
    );
  } finally {
    if ((await inspectReport(p.root, run.runId)).status === "running") {
      await controlRun(p.root, run.runId, { action: "stop" });
      await waitForRun(p.root, run.runId, AbortSignal.timeout(5000));
    }
  }
});

void test("background runs can be waited on and resumed from cache; launch failures name the run", async () => {
  const p = await project("return agent('hello fixture');");
  const launch = await command(["run", p.script, "--background", "--json"], p);
  assert.equal(launch.code, 0, launch.stderr);
  const run = launched.parse(JSON.parse(launch.stdout));
  const waited = await command(["wait", run.runId, "--json"], p);
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(final(waited.stdout).result, "hello fixture");

  const resumed = await command(
    ["run", p.script, "--resume", run.runId, "--json"],
    p,
  );
  assert.equal(resumed.code, 0, resumed.stderr);
  const report = final(resumed.stdout);
  assert.equal(report.status, "completed");
  assert.equal(report.result, "hello fixture");
  assert.equal(report.counts.cached, 1);
  const transcript = await command(
    ["show", report.runId, "--agent", "1", "--transcript"],
    p,
  );
  assert.match(transcript.stdout, /cache-hit/);
  // The link resolves to the original run's backend records.
  assert.match(transcript.stdout, /read-1/);
  assert.equal(await readFile(join(p.cwd, "calls"), "utf8"), "hello fixture\n");

  const unavailable = await command(
    ["run", p.script, "--backend", "codex", "--background", "--json"],
    p,
  );
  assert.equal(unavailable.code, 1);
  assert.match(unavailable.stderr, /unavailable/);
  assert.match(unavailable.stderr, /Run: wf_/);
});

void test("a startup deadline cancels discovery and never starts leaf work", async () => {
  const p = await project("return agent('must not start');", {
    transport: { launchTimeoutMs: 1000, discoveryTimeoutMs: 30_000 },
  });
  const pidFile = join(p.cwd, "discovery.json");
  p.env.WORKFLOW_FIXTURE_DISCOVERY_DELAY = "20000";
  p.env.WORKFLOW_FIXTURE_DISCOVERY_PID = pidFile;
  const started = performance.now();
  const launch = await command(["run", p.script, "--background", "--json"], p);
  const discovery = z
    .object({ pid: z.number(), supervisor: z.number() })
    .parse(JSON.parse(await readFile(pidFile, "utf8")));
  try {
    assert.equal(launch.code, 1);
    assert.match(launch.stderr, /timed out/);
    assert.ok(performance.now() - started < 4000);
    // The backend would otherwise outlive the launch by several seconds.
    await exited(discovery.pid);
    await assert.rejects(readFile(join(p.cwd, "calls"), "utf8"));
    const id = await onlyRunId(p);
    assert.notEqual((await inspectReport(p.root, id)).status, "running");
  } finally {
    if (alive(discovery.supervisor)) {
      process.kill(-discovery.supervisor, "SIGKILL");
    }
  }
});

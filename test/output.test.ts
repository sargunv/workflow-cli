import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { configSchema } from "../src/config.js";
import { agentTable, prepareReport, formatReport } from "../src/output.js";
import { Progress } from "../src/progress.js";
import type { ProgressSurface } from "../src/progress.js";
import { RunStore } from "../src/runtime/store.js";
import type { Json, Usage } from "../src/types.js";
import { tempDir } from "./helpers/common.js";

function surface(tty: boolean) {
  let now = 0;
  const output: string[] = [];
  const errors: string[] = [];
  const ui: ProgressSurface = {
    writeOut: (text) => output.push(text),
    writeErr: (text) => errors.push(text),
    tty,
    rows: () => 30,
    columns: () => 150,
    now: () => now,
  };
  return { ui, output, errors, tick: (value: number) => (now = value) };
}

async function completedReport(
  result: Json,
  agents: {
    usage?: Usage;
    cached?: boolean;
    prompt?: string;
    toolCalls?: number;
  }[] = [],
) {
  const root = await tempDir("output");
  const store = await RunStore.create({
    root,
    source: "source",
    args: null,
    config: configSchema.parse({}),
    meta: { name: "report", description: "report" },
    cwd: root,
    scriptPath: "script.js",
  });
  store.report.status = "completed";
  store.report.result = result;
  for (const [index, agent] of agents.entries()) {
    store.agent({
      id: index + 1,
      kind: "agent",
      prompt: agent.prompt ?? "task",
      options: {},
      key: `agent-${index}`,
      phase: "Run",
      status: "done",
      result: "PRIVATE RESULT",
      cached: agent.cached ?? false,
      startedAt: new Date().toISOString(),
      durationMs: 5,
      toolCalls: agent.toolCalls ?? 0,
      usage: agent.usage,
    });
  }
  return store.report;
}

void test("JSON progress coalesces streaming activity without losing lifecycle events", () => {
  const view = surface(false);
  const progress = new Progress(true, view.ui);
  progress.event({ type: "agent-started", id: 1 });
  for (let i = 0; i < 500; i++) {
    progress.event({ type: "activity", id: 1, text: `chunk ${i}` });
  }
  progress.flush();
  progress.event({
    type: "agent-finished",
    id: 1,
    status: "done",
    elapsedMs: 4000,
  });
  progress.close();
  const events = view.output.map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.type),
    ["agent-started", "activity", "agent-finished"],
  );
  assert.equal(events[1].text, "chunk 499");
});

void test("terminal output freezes finished elapsed time and neutralizes control bytes", async () => {
  const view = surface(true);
  const progress = new Progress(false, view.ui);
  progress.event({ type: "agent-started", id: 1, label: "Read" });
  view.tick(5000);
  progress.event({
    type: "agent-finished",
    id: 1,
    status: "done",
    elapsedMs: 5000,
  });
  progress.flush();
  view.tick(60000);
  progress.event({ type: "log", text: "status\u001b[2J" });
  progress.flush();
  progress.close();
  const live = view.errors.join("");
  assert.match(live, /5\.0s/);
  assert.doesNotMatch(live, /60\.0s/);
  assert.equal(live.includes("\u001b[2J"), false);

  const report = await completedReport(
    "first\n\tsecond\u001b]52;c;payload\u0007",
  );
  const human = formatReport(report, prepareReport(report));
  assert.ok(human.includes("first\n\tsecond"));
  assert.equal(human.includes("\u001b") || human.includes("\u0007"), false);
  assert.equal(prepareReport(report).result, report.result);
});

void test("summaries keep prompts and results out of tables and spill large results intact", async () => {
  const report = await completedReport("😀".repeat(10_000), [
    { prompt: "PRIVATE TASK" },
  ]);
  const summary = prepareReport(report);
  assert.ok(summary.resultPath);
  assert.ok(Buffer.byteLength(summary.preview ?? "") <= 4096);
  assert.doesNotMatch(summary.preview ?? "", /�/);
  assert.equal(
    JSON.parse(await readFile(summary.resultPath, "utf8")),
    report.result,
  );
  assert.doesNotMatch(JSON.stringify(agentTable(report)), /PRIVATE/);
  assert.doesNotMatch(formatReport(report, summary, true), /PRIVATE/);
});

void test("token totals count live agents and know the cached share only when all report it", async () => {
  const known = await completedReport(null, [
    { usage: { input: 100, cachedInput: 80, output: 5 }, toolCalls: 2 },
    { usage: { input: 20, cachedInput: 0, output: 3 }, toolCalls: 1 },
    {
      usage: { input: 1000, cachedInput: 0, output: 1000 },
      cached: true,
      toolCalls: 12,
    },
    {},
  ]);
  const summary = prepareReport(known);
  assert.equal(summary.toolCalls, 3);
  assert.equal(summary.cachedToolCalls, 12);
  assert.deepEqual(summary.tokens, {
    input: 120,
    cachedInput: 80,
    output: 8,
    unreportedAgents: 1,
  });
  assert.match(
    formatReport(known, summary),
    /120 input tokens \(80 cached\) · 8 output tokens/,
  );

  const partial = await completedReport(null, [
    { usage: { input: 100, cachedInput: 80, output: 5 } },
    { usage: { input: 20, output: 3 } },
  ]);
  assert.equal(prepareReport(partial).tokens.cachedInput, undefined);
});

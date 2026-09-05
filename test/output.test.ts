import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { agentTable, prepareReport, formatReport } from "../src/output.js";
import { Progress } from "../src/progress.js";
import type { ProgressSurface } from "../src/progress.js";
import { RunStore } from "../src/runtime/store.js";
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
void test("streaming activity is coalesced and terminal lifecycle stays intact", () => {
  const view = surface(false);
  const progress = new Progress(true, view.ui);
  progress.event({ type: "agent-started", id: 1 });
  for (let i = 0; i < 500; i++) {
    progress.event({
      type: "activity",
      id: 1,
      text: `chunk ${i}`,
      toolCalls: 3,
    });
  }
  assert.equal(view.output.length, 1);
  progress.flush();
  assert.equal(view.output.length, 2);
  assert.match(view.output[1] ?? "", /chunk 499/);
  progress.event({
    type: "agent-finished",
    id: 1,
    status: "done",
    elapsedMs: 4000,
  });
  progress.close();
  assert.equal(view.output.length, 3);
  assert.match(view.output[2] ?? "", /agent-finished/);
});
void test("completed elapsed time freezes and terminal control bytes are neutralized", () => {
  const view = surface(true);
  const progress = new Progress(false, view.ui);
  progress.event({
    type: "agent-started",
    id: 1,
    label: "Read",
    phase: "Review",
  });
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
  const text = view.errors.join("");
  assert.match(text, /5\.0s/);
  assert.doesNotMatch(text, /60\.0s/);
  assert.equal(text.includes("status\u001b"), false);
});
void test("summary tables omit prompts and results; large Unicode results spill intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-output-"));
  const store = new RunStore(
    root,
    "source",
    null,
    { name: "large", description: "large result" },
    root,
    "script.js",
  );
  store.report.status = "completed";
  store.report.result = "😀".repeat(10_000);
  store.agent({
    id: 1,
    kind: "agent",
    prompt: "PRIVATE TASK",
    options: {},
    key: "private",
    phase: "Review",
    status: "done",
    result: "PRIVATE RESULT",
    cached: true,
    startedAt: new Date().toISOString(),
    durationMs: 5,
    toolCalls: 12,
    usage: { input: 1, output: 2 },
  });
  const summary = prepareReport(store.report);
  assert.equal(summary.toolCalls, 0);
  assert.equal(summary.cachedToolCalls, 12);
  assert.equal(summary.tokens.output, 0);
  assert.ok(summary.resultPath);
  assert.ok(Buffer.byteLength(summary.preview ?? "") <= 4096);
  assert.doesNotMatch(summary.preview ?? "", /�/);
  assert.equal(
    JSON.parse(await readFile(summary.resultPath ?? "", "utf8")),
    store.report.result,
  );
  assert.doesNotMatch(JSON.stringify(agentTable(store.report)), /PRIVATE/);
  assert.doesNotMatch(
    formatReport(store.report, prepareReport(store.report), true),
    /PRIVATE/,
  );
});

void test("human result text neutralizes terminal sequences while preserving line breaks and JSON data", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-output-controls-"));
  const store = new RunStore(
    root,
    "source",
    null,
    { name: "controls", description: "controls" },
    root,
    "script.js",
  );
  store.report.status = "completed";
  store.report.result = "first\n\tsecond\u001b]52;c;payload\u0007";
  const human = formatReport(store.report, prepareReport(store.report));
  assert.ok(human.includes("first\n\tsecond"));
  assert.equal(human.includes("\u001b"), false);
  assert.equal(human.includes("\u0007"), false);
  assert.equal(prepareReport(store.report).result, store.report.result);
});

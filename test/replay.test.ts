import assert from "node:assert/strict";
import { mkdirSync, unlinkSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Replay, readTrace } from "../src/runtime/replay.js";
import { executeScript } from "../src/runtime/sandbox.js";
import { parseScript } from "../src/runtime/script.js";
const script =
  parseScript(`export const meta = { name:'replay', description:'reversed finishes' };
return pipeline(['A','B'], x => agent(x), x => agent('verify-' + x));`);
void test("replay preserves reversed completion order through no-barrier pipeline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-replay-"));
  const first = new Replay(join(dir, "first.jsonl"));
  const originalCalls: string[] = [];
  const replayCalls: string[] = [];
  const run = (replay: Replay, calls: string[]) =>
    executeScript(script, null, {
      validateAgent() {},
      log() {},
      phase() {},
      signal: new AbortController().signal,
      async workflow() {
        return null;
      },
      async agent(prompt) {
        const result = await replay.call(
          typeof prompt === "string" ? prompt : JSON.stringify(prompt),
          async () => {
            calls.push(
              typeof prompt === "string" ? prompt : JSON.stringify(prompt),
            );
            if (prompt === "A") {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return prompt;
          },
        );
        return result.value;
      },
    });
  const a = await run(first, originalCalls);
  assert.deepEqual(originalCalls, ["A", "B", "verify-B", "verify-A"]);
  const b = await run(
    new Replay(join(dir, "second.jsonl"), readTrace(join(dir, "first.jsonl"))),
    replayCalls,
  );
  assert.deepEqual(b, a);
  assert.deepEqual(replayCalls, []);
});
void test("first mismatch permanently invalidates suffix, including repeated old calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-replay-"));
  const first = new Replay(join(dir, "first.jsonl"));
  for (const key of ["one", "two", "three"]) {
    await first.call(key, async () => key);
  }
  const second = new Replay(
    join(dir, "second.jsonl"),
    readTrace(join(dir, "first.jsonl")),
  );
  const results = [];
  for (const key of ["one", "changed", "three"]) {
    results.push(await second.call(key, async () => key));
  }
  assert.deepEqual(
    results.map((result) => result.cached),
    [true, false, false],
  );
});
void test("removed concurrent invocation cannot deadlock cached prefix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-replay-"));
  const first = new Replay(join(dir, "first.jsonl"));
  await Promise.all(
    ["one", "two"].map((key) => first.call(key, async () => key)),
  );
  const second = new Replay(
    join(dir, "second.jsonl"),
    readTrace(join(dir, "first.jsonl")),
  );
  assert.deepEqual(await second.call("one", async () => "live"), {
    value: "one",
    cached: true,
  });
  assert.deepEqual(await second.call("new", async () => "live"), {
    value: "live",
    cached: false,
  });
});
void test("journal tolerates a torn last append and rejects middle corruption", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-replay-"));
  const path = join(dir, "journal");
  await writeFile(path, '{"type":"start","id":1,"key":"x"}\n{"type":"fi');
  assert.equal(readTrace(path).length, 1);
  await writeFile(path, (await readFile(path, "utf8")) + "\n");
  assert.throws(() => readTrace(path), /line 2/);
});

void test("cached completion persistence failure rejects every waiter instead of escaping the event loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-replay-failure-"));
  const path = join(dir, "trace.jsonl");
  const replay = new Replay(path, [
    { type: "start", id: 1, key: "one" },
    { type: "start", id: 2, key: "two" },
    { type: "finish", id: 2, value: "two" },
    { type: "finish", id: 1, value: "one" },
  ]);
  const one = replay.call("one", async () => "live");
  const two = replay.call("two", async () => "live");
  unlinkSync(path);
  mkdirSync(path);
  const settled = await Promise.allSettled([one, two]);
  assert.deepEqual(
    settled.map((result) => result.status),
    ["rejected", "rejected"],
  );
  assert.throws(() => replay.call("later", async () => "live"), /EISDIR/);
});

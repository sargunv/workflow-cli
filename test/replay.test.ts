import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { Replay, readTrace } from "../src/runtime/replay.ts";
import { executeScript } from "../src/runtime/sandbox.ts";
import { tempDir } from "./helpers/common.ts";
import { host, script, text } from "./helpers/sandbox.ts";

async function replays() {
  const dir = await tempDir("replay");
  return {
    first: new Replay(join(dir, "first.jsonl")),
    resume: () =>
      new Replay(
        join(dir, "second.jsonl"),
        readTrace(join(dir, "first.jsonl")),
      ),
  };
}

void test("replay preserves reversed completion order through a no-barrier pipeline", async () => {
  const { first, resume } = await replays();
  const pipeline = script(
    "return pipeline(['A','B'], x => agent(x), x => agent('verify-' + x));",
  );
  const run = (replay: Replay, calls: string[]) =>
    executeScript(
      pipeline,
      null,
      host({
        async agent(prompt) {
          const key = text(prompt);
          const result = await replay.call(key, async () => {
            calls.push(key);
            if (key === "A") {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return key;
          });
          return result.value;
        },
      }),
    );
  const originalCalls: string[] = [];
  const original = await run(first, originalCalls);
  assert.deepEqual(originalCalls, ["A", "B", "verify-B", "verify-A"]);
  const replayCalls: string[] = [];
  assert.deepEqual(await run(resume(), replayCalls), original);
  assert.deepEqual(replayCalls, []);
});

void test("the first mismatch invalidates the rest of the trace, even repeated keys", async () => {
  const { first, resume } = await replays();
  for (const key of ["one", "two", "three"]) {
    await first.call(key, async () => key);
  }
  const second = resume();
  const cached = [];
  for (const key of ["one", "changed", "three"]) {
    cached.push((await second.call(key, async () => key)).cached);
  }
  assert.deepEqual(cached, [true, false, false]);
});

void test("a removed concurrent call cannot deadlock the cached prefix", async () => {
  const { first, resume } = await replays();
  await Promise.all(
    ["one", "two"].map((key) => first.call(key, async () => key)),
  );
  const second = resume();
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
  const path = join(await tempDir("replay"), "journal");
  await writeFile(path, '{"type":"start","id":1,"key":"x"}\n{"type":"fi');
  assert.equal(readTrace(path).length, 1);
  await writeFile(path, (await readFile(path, "utf8")) + "\n");
  assert.throws(() => readTrace(path), /line 2/);
});

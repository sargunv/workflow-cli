import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { executeScript } from "../src/runtime/sandbox.js";
import { compileSchema } from "../src/runtime/schema.js";
import { parseScript } from "../src/runtime/script.js";
import { agentOptions } from "../src/types.js";
import type { Json } from "../src/types.js";

function object(value: Json | undefined): { [key: string]: Json } {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value;
}
function array(value: Json | undefined): Json[] {
  assert.ok(Array.isArray(value));
  return value;
}
async function example(
  name: string,
  args: Json,
  respond: (prompt: string) => Json,
) {
  const logs: string[] = [];
  const calls: string[] = [];
  const script = parseScript(
    await readFile(new URL(`../examples/${name}.js`, import.meta.url), "utf8"),
  );
  const result = await executeScript(script, args, {
    signal: new AbortController().signal,
    phase() {},
    log(message) {
      logs.push(message);
    },
    async workflow() {
      throw Error("Examples should be self-contained");
    },
    validateAgent(prompt, opts) {
      assert.equal(typeof prompt, "string");
      const options = agentOptions.parse(opts);
      if (options.schema) {
        compileSchema(options.schema);
      }
    },
    async agent(prompt, opts) {
      assert.equal(typeof prompt, "string");
      const text = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
      calls.push(text);
      const result = respond(text);
      const options = agentOptions.parse(opts);
      if (result !== null && options.schema) {
        assert.ok(compileSchema(options.schema)(result));
      }
      return result;
    },
  });
  return { result, logs, calls };
}
void test("hello inherits run defaults without undefined options", async () => {
  const output = await example("hello", null, () => ({ greeting: "Hello" }));
  assert.deepEqual(output.result, { greeting: "Hello" });
});
void test("adversarial majority never counts a failed refuter as positive", async () => {
  let count = 0;
  const output = await example(
    "adversarial-verify",
    { task: "Inspect /repo", findings: ["claim"] },
    () => (++count === 1 ? { valid: true, reason: "Evidence" } : null),
  );
  assert.equal(object(array(output.result)[0]).accepted, false);
  assert.ok(output.logs.some((line) => line.includes("2 refuters failed")));
});
void test("perspective reviews remain blind and synthesis discloses missing coverage", async () => {
  const output = await example(
    "perspective-diverse-verify",
    { task: "Inspect /repo", claim: "claim" },
    (prompt): Json => {
      if (prompt.includes("Reviews in the same order")) {
        return "synthesis";
      }
      if (prompt.includes("security")) {
        return null;
      }
      return { valid: false, reason: "counterevidence" };
    },
  );
  assert.equal(output.calls.length, 5);
  for (const prompt of output.calls.slice(0, 4)) {
    assert.ok(!prompt.includes("counterevidence"));
  }
  assert.ok(output.calls[4]?.includes("counterevidence"));
  assert.ok(output.logs.some((line) => line.includes("1 lenses failed")));
});
void test("judge panel handles ties and excludes candidates with incomplete panels", async () => {
  const output = await example(
    "judge-panel",
    { task: "Inspect /repo" },
    (prompt): Json => {
      if (prompt.includes("Independently judge")) {
        return { score: 8, reason: "Evidence" };
      }
      if (prompt.includes("failure cases first")) {
        return null;
      }
      return "proposal";
    },
  );
  const result = object(output.result);
  assert.equal(object(result.winner).index, 0);
  assert.equal(array(result.candidates)[1], null);
  assert.ok(output.logs.some((line) => line.includes("2 candidates tied")));
  const failed = await example(
    "judge-panel",
    { task: "Inspect /repo" },
    (prompt): Json =>
      prompt.includes("Independently judge") ? null : "proposal",
  );
  assert.equal(object(failed.result).winner, null);
  assert.ok(failed.logs.some((line) => line.includes("incomplete panel")));
});
void test("dry loop deduplicates rejected identities within and across rounds", async () => {
  const output = await example(
    "loop-until-dry",
    { task: "Inspect /repo" },
    (prompt): Json =>
      prompt.startsWith("Find concrete")
        ? {
            findings: [
              { id: "same", claim: "claim" },
              { id: "same", claim: "duplicate" },
            ],
          }
        : { valid: false, reason: "refuted" },
  );
  const result = object(output.result);
  assert.equal(result.rounds, 3);
  assert.equal(result.converged, true);
  assert.equal(array(result.evaluated).length, 1);
  assert.equal(
    output.calls.filter((prompt): Json => prompt.includes("Try to refute"))
      .length,
    1,
  );
  const failed = await example(
    "loop-until-dry",
    { task: "Inspect /repo" },
    () => null,
  );
  assert.equal(object(failed.result).converged, false);
});
void test("deferred budget uses a finite announced fallback", async () => {
  const output = await example(
    "loop-until-budget",
    { task: "Inspect /repo", maxRounds: 2 },
    () => "evidence",
  );
  assert.equal(output.calls.length, 2);
  assert.ok(output.logs.some((line) => line.includes("ceiling is disabled")));
  assert.ok(
    output.logs.some((line) => line.includes("not a completeness claim")),
  );
});
void test("multi-modal sweep deduplicates across searchers and retains failed coverage", async () => {
  const output = await example(
    "multi-modal-sweep",
    { task: "Inspect /repo" },
    (prompt): Json => {
      if (prompt.includes("Search using")) {
        return prompt.includes("git history")
          ? null
          : { findings: [{ id: "same", claim: "claim" }] };
      }
      return { valid: true, reason: "evidence" };
    },
  );
  const result = object(output.result);
  assert.equal(result.failedStrategies, 1);
  assert.equal(result.duplicates, 2);
  assert.equal(array(result.findings).length, 1);
});
void test("completeness critic gets all context and preserves unsupported claims", async () => {
  const output = await example(
    "completeness-critic",
    {
      task: "Inspect /repo",
      requirements: ["runtime"],
      evidence: "compile only",
      result: "complete",
    },
    () => ({
      missing: ["runtime"],
      unsupported: ["complete"],
      explanation: "compile only",
    }),
  );
  assert.ok(output.calls[0]?.includes("compile only"));
  assert.deepEqual(object(object(output.result).critic).unsupported, [
    "complete",
  ]);
});
void test("no silent caps reports duplicates, omissions and failed work", async () => {
  const output = await example(
    "no-silent-caps",
    { task: "Inspect /repo", items: ["a", "a", "b", "c"], limit: 2 },
    () => null,
  );
  const result = object(output.result);
  assert.deepEqual(result.omitted, ["c"]);
  assert.equal(result.duplicateCount, 1);
  assert.equal(output.calls.length, 2);
  assert.ok(output.logs.some((line) => line.includes("deferring 1")));
  assert.equal(
    output.logs.filter((line) => line.includes("Failed review")).length,
    2,
  );
});

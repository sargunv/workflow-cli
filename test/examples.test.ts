import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { executeScript } from "../src/runtime/sandbox.js";
import { compileSchema } from "../src/runtime/schema.js";
import { parseScript } from "../src/runtime/script.js";
import { agentOptions } from "../src/types.js";
import type { Json } from "../src/types.js";
import { host, text } from "./helpers/sandbox.js";

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

/** Runs an example with each prompt answered by `respond`, which must satisfy
 * the call's own schema; the example's option objects must be valid too. */
async function example(
  name: string,
  args: Json,
  respond: (prompt: string) => Json,
) {
  const logs: string[] = [];
  const calls: string[] = [];
  const source = await readFile(
    new URL(`../examples/${name}.js`, import.meta.url),
    "utf8",
  );
  const result = await executeScript(
    parseScript(source),
    args,
    host({
      log: (message) => logs.push(message),
      async agent(prompt, opts) {
        const options = agentOptions.parse(opts);
        const asked = text(prompt);
        calls.push(asked);
        const answer = respond(asked);
        if (answer !== null && options.schema) {
          assert.ok(compileSchema(options.schema)(answer), asked);
        }
        return answer;
      },
    }),
  );
  return { result, logs, calls };
}

void test("hello passes only defined options", async () => {
  const { result } = await example("hello", null, () => ({ greeting: "Hi" }));
  assert.deepEqual(result, { greeting: "Hi" });
});

void test("adversarial majority never counts a failed refuter as positive", async () => {
  let count = 0;
  const { result } = await example(
    "adversarial-verify",
    { task: "Inspect /repo", findings: ["claim"] },
    () => (++count === 1 ? { valid: true, reason: "Evidence" } : null),
  );
  assert.equal(object(array(result)[0]).accepted, false);
});

void test("perspective reviews stay blind and synthesis sees missing coverage", async () => {
  const { calls, logs } = await example(
    "perspective-diverse-verify",
    { task: "Inspect /repo", claim: "claim" },
    (prompt): Json => {
      if (prompt.includes("Reviews in the same order")) {
        return "synthesis";
      }
      return prompt.includes("security")
        ? null
        : { valid: false, reason: "counterevidence" };
    },
  );
  assert.equal(calls.length, 5);
  assert.ok(calls.slice(0, 4).every((p) => !p.includes("counterevidence")));
  assert.ok(calls[4]?.includes("counterevidence"));
  assert.ok(logs.some((line) => line.includes("failed")));
});

void test("judge panel breaks ties deterministically and excludes incomplete panels", async () => {
  const { result } = await example(
    "judge-panel",
    { task: "Inspect /repo" },
    (prompt): Json => {
      if (prompt.includes("Independently judge")) {
        return { score: 8, reason: "Evidence" };
      }
      return prompt.includes("failure cases first") ? null : "proposal";
    },
  );
  assert.equal(object(object(result).winner).index, 0);
  assert.equal(array(object(result).candidates)[1], null);
  const failed = await example(
    "judge-panel",
    { task: "Inspect /repo" },
    (prompt): Json =>
      prompt.includes("Independently judge") ? null : "proposal",
  );
  assert.equal(object(failed.result).winner, null);
});

void test("dry loop deduplicates rejected identities and reports failure", async () => {
  const { result, calls } = await example(
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
  assert.equal(object(result).converged, true);
  assert.equal(array(object(result).evaluated).length, 1);
  assert.equal(calls.filter((p) => p.includes("Try to refute")).length, 1);
  const failed = await example(
    "loop-until-dry",
    { task: "Inspect /repo" },
    () => null,
  );
  assert.equal(object(failed.result).converged, false);
});

void test("budget loop stops at its explicit round fallback", async () => {
  const { result, calls } = await example(
    "loop-until-budget",
    { task: "Inspect /repo", maxRounds: 2 },
    () => "evidence",
  );
  assert.equal(calls.length, 2);
  assert.equal(object(result).stopReason, "round limit");
});

void test("multi-modal sweep deduplicates across searchers and counts failed ones", async () => {
  const { result } = await example(
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
  assert.equal(object(result).failedStrategies, 1);
  assert.equal(array(object(result).findings).length, 1);
});

void test("completeness critic sees the evidence and reports unsupported claims", async () => {
  const { result, calls } = await example(
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
  assert.ok(calls[0]?.includes("compile only"));
  assert.deepEqual(object(object(result).critic).unsupported, ["complete"]);
});

void test("no silent caps returns omitted items and keeps failed ones", async () => {
  const { result, calls } = await example(
    "no-silent-caps",
    { task: "Inspect /repo", items: ["a", "a", "b", "c"], limit: 2 },
    () => null,
  );
  const { omitted, duplicateCount, results } = object(result);
  assert.deepEqual(omitted, ["c"]);
  assert.equal(duplicateCount, 1);
  assert.equal(calls.length, 2);
  assert.equal(array(results).length, 2);
});

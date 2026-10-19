import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultSandbox } from "../src/config.js";
import { itemsPerCall } from "../src/runtime/limits.js";
import { executeScript } from "../src/runtime/sandbox.js";
import type { SandboxHost } from "../src/runtime/sandbox.js";
import { compileSchema } from "../src/runtime/schema.js";
import { parseScript } from "../src/runtime/script.js";
import { host, script, text } from "./helpers/sandbox.js";

const run = (body: string, overrides: Partial<SandboxHost> = {}) =>
  executeScript(script(body), null, host(overrides));

void test("plain JavaScript awaits agents and returns structured results", async () => {
  assert.deepEqual(
    await executeScript(
      script("return {answer: await agent(args.question)}"),
      { question: "hello" },
      host(),
    ),
    { answer: "hello" },
  );
});

void test("sandbox denies clocks, randomness, host globals and constructor escape", async () => {
  for (const expression of [
    "Date.now()",
    'Object.getOwnPropertyDescriptor(Date, "now").value()',
    "new Date()",
    "Date()",
    "Math.random()",
    "new (new Date(0).constructor)()",
    '({}).constructor.constructor("return process")()',
  ]) {
    await assert.rejects(run(`return ${expression}`), expression);
  }
  assert.deepEqual(
    await run(
      "return [typeof process, typeof fetch, typeof require, typeof setTimeout, new Date(0).getTime()]",
    ),
    ["undefined", "undefined", "undefined", "undefined", 0],
  );
});

void test("scripts need a pure literal header and cannot import", () => {
  for (const meta of [
    '{name: foo(), description: "x"}',
    '{name: "x", ...args}',
    '{get name(){return "x"}}',
  ]) {
    assert.throws(() =>
      parseScript(`export const meta = ${meta}; return null`),
    );
  }
  assert.throws(() => script('return import("node:fs")'));
});

void test("pipeline has no inter-stage barrier, preserves item/index and nulls throws", async () => {
  const events: string[] = [];
  const warnings: string[] = [];
  const result = await run(
    `return pipeline(['slow','fast','bad'], async item => { if(item === 'bad') throw Error('bad'); return agent(item) }, (previous, original, index) => agent(previous + ':' + original + ':' + index))`,
    {
      async agent(prompt) {
        const asked = text(prompt);
        if (asked === "slow") {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        events.push(asked);
        return asked;
      },
      warn: (message) => warnings.push(message),
    },
  );
  assert.deepEqual(result, ["slow:slow:0", "fast:fast:1", null]);
  assert.equal(warnings.length, 1);
  assert.ok(events.indexOf("fast:fast:1") < events.indexOf("slow"));
});

void test("parallel nulls failed items and enforces its item limit", async () => {
  assert.deepEqual(
    await run(
      'return parallel([() => 1, () => {throw Error("bad")}, async () => 3])',
    ),
    [1, null, 3],
  );
  await assert.rejects(
    run(`return parallel(Array(${itemsPerCall + 1}).fill(() => 1))`),
  );
});

void test("runaway loops and memory growth are interrupted", async () => {
  const limits = { ...defaultSandbox, interruptChecks: 20 };
  for (const body of [
    "while(true) {}",
    "while(true) { await Promise.resolve(); }",
  ]) {
    await assert.rejects(
      executeScript(script(body), null, host(), limits),
      /interrupted/,
    );
  }
  await assert.rejects(
    executeScript(script("return 'x'.repeat(4 * 1024 * 1024)"), null, host(), {
      ...defaultSandbox,
      memoryBytes: 1024 * 1024,
    }),
    /out of memory/,
  );
});

void test("abort stops a sandbox awaiting a never completing host operation", async () => {
  const controller = new AbortController();
  const result = run('return agent("wait")', {
    signal: controller.signal,
    agent: () => new Promise(() => {}),
  });
  setImmediate(() => controller.abort(new Error("cancelled")));
  await assert.rejects(result, /cancelled/);
});

void test("agent validation throws synchronously into the script", async () => {
  assert.equal(
    await run('try { agent("bad") } catch { return "caught" }', {
      validateAgent() {
        throw Error("bad options");
      },
    }),
    "caught",
  );
});

void test("values crossing the bridge reject silent JSON data loss", async () => {
  await assert.rejects(run('return agent("x", {model: undefined})'));
  for (const expression of [
    "({x:undefined})",
    // A script cannot weaken the guest's own checks by patching builtins.
    "(() => { Array.prototype.includes = () => false; return {x:undefined}; })()",
    "({x:NaN})",
    "(()=>1)",
    "new Map([['x', 1]])",
  ]) {
    await assert.rejects(run(`return ${expression}`), expression);
  }
});

void test("agent schemas must describe an object and keep optional properties optional", () => {
  assert.throws(() => compileSchema({ type: "array" }));
  assert.throws(() =>
    compileSchema({ type: "object", properties: {}, required: ["missing"] }),
  );
  const validate = compileSchema({
    type: "object",
    properties: { x: { type: "string" } },
  });
  assert.ok(validate({ extra: true }));
  assert.equal(validate({ x: 2 }), false);
});

void test("script errors are concise and point into the workflow", async () => {
  await assert.rejects(run("throw Error('Pass task input')"), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Pass task input/);
    assert.match(error.message, /workflow\.js/);
    assert.ok(error.message.length < 250);
    return true;
  });
});

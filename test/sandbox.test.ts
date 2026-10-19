import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultSandbox } from "../src/config.js";
import { itemsPerCall } from "../src/runtime/limits.js";
import { executeScript } from "../src/runtime/sandbox.js";
import type { SandboxHost } from "../src/runtime/sandbox.js";
import { compileSchema } from "../src/runtime/schema.js";
import { parseScript } from "../src/runtime/script.js";
const source = (body: string) =>
  parseScript(
    `export const meta = {name: 'test', description: 'test'};\n${body}`,
  );
function host(overrides: Partial<SandboxHost> = {}): SandboxHost {
  return {
    validateAgent() {},
    async agent(prompt) {
      return prompt;
    },
    async workflow() {
      return null;
    },
    log() {},
    phase() {},
    signal: new AbortController().signal,
    ...overrides,
  };
}
void test("plain JavaScript awaits agents and returns structured results", async () => {
  assert.deepEqual(
    await executeScript(
      source("return {answer: await agent(args.question)}"),
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
    await assert.rejects(
      executeScript(source(`return ${expression}`), null, host()),
    );
  }
  assert.deepEqual(
    await executeScript(
      source(
        "return [typeof process, typeof fetch, typeof require, typeof setTimeout, new Date(0).toISOString()]",
      ),
      null,
      host(),
    ),
    [
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "1970-01-01T00:00:00.000Z",
    ],
  );
});
void test("pure literal header rejects executable metadata and imports", () => {
  for (const meta of [
    '{name: foo(), description: "x"}',
    '{name: "x", ...args}',
    '{get name(){return "x"}}',
    '{name: `x${args}`, description: "x"}',
  ]) {
    assert.throws(() =>
      parseScript(`export const meta = ${meta}; return null`),
    );
  }
  assert.throws(() => source('return import("node:fs")'));
  assert.throws(() => source('const value: string = "x"'));
});
void test("pipeline has no inter-stage barrier, preserves item/index and catches throws", async () => {
  const events: string[] = [];
  const warnings: string[] = [];
  const result = await executeScript(
    source(
      `return pipeline(['slow','fast','bad'], async item => { if(item === 'bad') throw Error('bad'); return agent(item) }, (previous, original, index) => agent(previous + ':' + original + ':' + index))`,
    ),
    null,
    host({
      async agent(prompt) {
        const text =
          typeof prompt === "string" ? prompt : JSON.stringify(prompt);
        if (text === "slow") {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        events.push(text);
        return text;
      },
      warn: (message) => warnings.push(message),
    }),
  );
  assert.deepEqual(result, ["slow:slow:0", "fast:fast:1", null]);
  assert.deepEqual(warnings, ["pipeline item 2 returned null: bad"]);
  assert.ok(events.indexOf("fast:fast:1") < events.indexOf("slow"));
});
void test("parallel handles failures and enforces explicit item limit", async () => {
  const warnings: string[] = [];
  assert.deepEqual(
    await executeScript(
      source(
        'return parallel([() => 1, () => {throw Error("bad")}, async () => 3])',
      ),
      null,
      host({ warn: (message) => warnings.push(message) }),
    ),
    [1, null, 3],
  );
  assert.deepEqual(warnings, ["parallel item 1 returned null: bad"]);
  await assert.rejects(
    executeScript(
      source(`return parallel(Array(${itemsPerCall + 1}).fill(() => 1))`),
      null,
      host(),
    ),
    new RegExp(`at most ${itemsPerCall} functions`),
  );
});
void test("runaway synchronous and microtask loops are interrupted", async () => {
  await assert.rejects(
    executeScript(source("while(true) {}"), null, host(), {
      ...defaultSandbox,
      interruptChecks: 20,
    }),
    /interrupted/,
  );
  await assert.rejects(
    executeScript(
      source("while(true) { await Promise.resolve(); }"),
      null,
      host(),
      { ...defaultSandbox, interruptChecks: 20 },
    ),
    /interrupted/,
  );
});
void test("abort stops a sandbox awaiting a never completing host operation", async () => {
  const controller = new AbortController();
  const result = executeScript(
    source('return agent("wait")'),
    null,
    host({ signal: controller.signal, agent: () => new Promise(() => {}) }),
  );
  setTimeout(() => controller.abort(new Error("cancelled")), 20);
  await assert.rejects(result, /cancelled/);
});
void test("call validation throws synchronously and arguments cannot silently lose fields", async () => {
  assert.equal(
    await executeScript(
      source('try { agent("bad") } catch { return "caught" }'),
      null,
      host({
        validateAgent() {
          throw Error("bad options");
        },
      }),
    ),
    "caught",
  );
  await assert.rejects(
    executeScript(
      source('return agent("x", {model: undefined})'),
      null,
      host(),
    ),
    /finite JSON/,
  );
});
void test("schema root, required keys and original optional-property semantics", () => {
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

void test("bootstrap closures and temporary host globals are not reachable by workflow source", async () => {
  const privateNames = [
    "NativeDate",
    "dispatch",
    "validate",
    "notify",
    "encode",
    "pending",
    "argsJson",
    "metaJson",
    "itemsPerCall",
    "itemsPerCallJson",
    "settle",
    "encodeResult",
    "__dispatch",
    "__validate",
    "__notify",
    "__argsJson",
    "__metaJson",
    "__itemsPerCallJson",
  ];
  const expression = privateNames.map((name) => `typeof ${name}`).join(", ");
  assert.deepEqual(
    await executeScript(source(`return [${expression}]`), null, host()),
    privateNames.map(() => "undefined"),
  );
});
void test("final results reject silent JSON data loss", async () => {
  for (const expression of [
    "({x:undefined})",
    "(() => { Array.prototype.includes = () => false; return {x:undefined}; })()",
    "({x:NaN})",
    "({f:()=>1})",
    "(()=>1)",
    "({x:Infinity})",
    "new Map([['x', 1]])",
    "new Set([1])",
    "(/pattern/)",
  ]) {
    await assert.rejects(
      executeScript(source(`return ${expression}`), null, host()),
      /finite JSON/,
    );
  }
});

void test("script errors show a concise message and workflow location", async () => {
  await assert.rejects(
    executeScript(source("throw Error('Pass task input')"), null, host()),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^Error: Pass task input/);
      assert.match(error.message, /workflow\.js/);
      assert.ok(error.message.length < 250);
      assert.equal(error.message.includes('"stack"'), false);
      return true;
    },
  );
});

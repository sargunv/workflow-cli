import assert from "node:assert/strict";
import { test } from "node:test";

import { formatWorkflow } from "../scripts/format-examples.js";
import { executeScript } from "../src/runtime/sandbox.js";
import { parseScript } from "../src/runtime/script.js";

void test("workflow formatting preserves multiline literal data, comment indentation and is idempotent", async () => {
  const comment = "/* Diagram:\n    parent\n      child\n  */";
  const source = [
    'export const meta={name:"literals",description:"Literal formatting regression"};',
    comment,
    "const cooked = `first",
    "  two spaces",
    "    four spaces`;",
    "const raw = String.raw`first",
    "  ${cooked}",
    "    last`;",
    'const continued = "first\\',
    '  last";',
    "return {cooked,raw,continued};",
  ].join("\n");
  const formatted = formatWorkflow(source);
  assert.ok(
    formatted.includes(comment),
    "block-comment indentation is preserved",
  );
  const run = (script: string) =>
    executeScript(parseScript(script), null, {
      agent: async () => null,
      workflow: async () => null,
      validateAgent: () => {},
      log: () => {},
      phase: () => {},
      signal: new AbortController().signal,
    });
  assert.deepEqual(await run(formatted), await run(source));
  assert.equal(formatWorkflow(formatted), formatted);
});

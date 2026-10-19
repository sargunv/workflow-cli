import assert from "node:assert/strict";
import { test } from "node:test";

import { formatWorkflow } from "../scripts/format-examples.ts";
import { executeScript } from "../src/runtime/sandbox.ts";
import { parseScript } from "../src/runtime/script.ts";
import { host } from "./helpers/sandbox.ts";

void test("example formatting preserves multiline literals and comment indentation and is idempotent", async () => {
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
  assert.ok(formatted.includes(comment));
  const run = (text: string) => executeScript(parseScript(text), null, host());
  assert.deepEqual(await run(formatted), await run(source));
  assert.equal(formatWorkflow(formatted), formatted);
});

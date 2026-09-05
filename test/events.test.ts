import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { codexModels, cursorModels, CliDriver } from "../src/drivers/cli.js";
import {
  CliEventParser,
  AcpEventParser,
  object,
} from "../src/drivers/events.js";
import { parseStructured } from "../src/runtime/schema.js";
import type { DriverEvent } from "../src/types.js";
void test("recorded Claude stream yields native structured output and tool usage", async () => {
  const events: DriverEvent[] = [];
  const parser = new CliEventParser("claude", (event) => events.push(event));
  for (const line of (
    await readFile(
      new URL("./fixtures/claude-success.jsonl", import.meta.url),
      "utf8",
    )
  )
    .trim()
    .split("\n"))
    parser.line(line, "stdout");
  const result = parser.finish(0);
  assert.equal(result.exitInfo.error, undefined);
  assert.deepEqual(result.structured, {
    greeting: "Ready to orchestrate your workflow",
  });
  assert.equal(events.filter((event) => event.type === "tool").length, 1);
  assert.equal(result.usage?.output, 214);
});

void test("recorded native ACP streams retain only each turn's final answer and actual usage", async () => {
  for (const backend of ["opencode", "kimi", "qwen"]) {
    const events: DriverEvent[] = [];
    const parser = new AcpEventParser((event) => events.push(event));
    const turns = [];
    const records = (
      await readFile(
        new URL(`./fixtures/acp-${backend}.jsonl`, import.meta.url),
        "utf8",
      )
    )
      .trim()
      .split("\n");
    for (const line of records) {
      const event = JSON.parse(line);
      if (event.method === "session/update")
        parser.update(object(event.params.update));
      if (event.result?.stopReason) {
        turns.push(parser.finish(object(event.result)));
        parser.reset();
      }
    }
    assert.deepEqual(
      turns.map((turn) => JSON.parse(turn.text)),
      [{ code: 731 }, { remembered: 731 }],
      backend,
    );
    assert.equal(
      events.filter((event) => event.type === "tool").length,
      1,
      backend,
    );
    if (backend === "opencode")
      assert.deepEqual(
        turns.map((turn) => turn.usage?.output),
        [9, 10],
      );
    else
      assert.ok(
        turns.every((turn) => turn.usage === undefined),
        "context occupancy must not become token usage",
      );
  }
});

void test("recorded Codex and Cursor streams report vendor final text and usage", async () => {
  for (const backend of ["codex", "cursor"] as const) {
    const parser = new CliEventParser(backend, () => {});
    for (const line of (
      await readFile(
        new URL(`./fixtures/${backend}-success.jsonl`, import.meta.url),
        "utf8",
      )
    )
      .trim()
      .split("\n"))
      parser.line(line, "stdout");
    const result = parser.finish(0);
    assert.equal(result.exitInfo.error, undefined);
    assert.deepEqual(parseStructured(result.text), { code: 731 });
    assert.equal(result.usage?.output, backend === "codex" ? 311 : 286);
  }
});

void test("recorded Codex catalog excludes hidden models and unrepresentable effort levels", async () => {
  const models = codexModels(
    await readFile(
      new URL("./fixtures/codex-models.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(models.length, 8);
  assert.equal(
    models.some(
      (model) => model.id === "gpt-reserve" || model.id === "codex-auto-review",
    ),
    false,
  );
  assert.equal(
    models.some((model) => model.efforts.includes("ultra")),
    false,
  );
  assert.deepEqual(
    models.find((model) => model.id === "gpt-6-astra")?.efforts,
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(
    models.some((model) => model.default),
    false,
    "catalog ordering does not prove the user's configured default",
  );
});

void test("recorded Claude read-only policy retains its native output tool", async () => {
  const events = (
    await readFile(
      new URL("./fixtures/claude-read-only-schema.jsonl", import.meta.url),
      "utf8",
    )
  )
    .trim()
    .split("\n");
  const init = JSON.parse(events[0] ?? "null");
  assert.deepEqual(init.tools, ["Glob", "Grep", "Read", "StructuredOutput"]);
  const parser = new CliEventParser("claude", () => {});
  for (const line of events) parser.line(line, "stdout");
  assert.deepEqual(parser.finish(0).structured, { ok: true });
});

void test("Cursor catalog preserves literal effort model IDs and its reported default", async () => {
  const models = cursorModels(
    await readFile(
      new URL("./fixtures/cursor-models.txt", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(models.length > 30);
  assert.equal(models.find((model) => model.default)?.id, "auto");
  assert.ok(models.some((model) => model.id === "composer-2.5"));
  assert.ok(models.some((model) => model.id === "gpt-5.6-sol-xhigh"));
});
void test("CLI usage is absent when counters are missing and Claude includes cache input", () => {
  for (const backend of ["claude", "codex", "cursor"] as const) {
    const parser = new CliEventParser(backend, () => {});
    parser.line(
      JSON.stringify({
        type: backend === "codex" ? "turn.completed" : "result",
        result: "answer",
      }),
      "stdout",
    );
    assert.equal(parser.finish(0).usage, undefined);
  }
  const claude = new CliEventParser("claude", () => {});
  claude.line(
    JSON.stringify({
      type: "result",
      result: "answer",
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
      },
    }),
    "stdout",
  );
  assert.deepEqual(claude.finish(0).usage, { input: 310, output: 2 });
});
void test("Claude minimal capability requires explicit API-key authentication", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    // No installed binary is invoked: make discovery deliberately unavailable.
    const path = process.env.PATH;
    process.env.PATH = "";
    try {
      const detection = await new CliDriver("claude").detect(process.cwd());
      assert.equal(detection.minimal, false);
      assert.ok(
        detection.notes.some((note) => note.includes("ANTHROPIC_API_KEY")),
      );
      process.env.ANTHROPIC_API_KEY = "offline-fixture";
      assert.equal(
        (await new CliDriver("claude").detect(process.cwd())).minimal,
        true,
      );
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

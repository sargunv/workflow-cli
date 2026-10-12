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

function feed(parser: CliEventParser, ...events: unknown[]) {
  for (const event of events) {
    parser.line(JSON.stringify(event), "stdout");
  }
}

void test("source-derived quota refusals retain details despite stderr and emit once", async () => {
  for (const backend of ["claude", "codex"] as const) {
    const events: DriverEvent[] = [];
    const parser = new CliEventParser(backend, (event) => events.push(event));
    const lines = await readFile(
      new URL(`./fixtures/${backend}-usage-limit.jsonl`, import.meta.url),
      "utf8",
    );
    for (const line of lines.trim().split("\n")) {
      parser.line(line, "stdout");
    }

    const result = parser.finish(1, "backend stderr summary");
    assert.ok(result.usageLimit);
    assert.match(result.usageLimit.message, /usage limit/);
    assert.equal(
      events.filter((event) => event.type === "usage-limit").length,
      1,
    );
    if (backend === "claude") {
      assert.equal(result.usageLimit.limit, "seven_day_opus");
      assert.equal(result.usageLimit.resetsAt, "2026-10-13T00:00:00.000Z");
    } else {
      assert.match(result.usageLimit.message, /Oct 13th, 2026 10:00 AM/);
      assert.equal(
        result.usageLimit.resetsAt,
        undefined,
        "preserve the vendor reset text without inventing a timezone",
      );
    }
  }
});

void test("Claude legacy refusals and errors arrays interrupt only failed terminal results", () => {
  const cases: Array<[boolean, Record<string, unknown>]> = [
    [
      true,
      { result: "You've hit your limit · resets 10am (America/Los_Angeles)" },
    ],
    [
      true,
      {
        subtype: "error_during_execution",
        errors: ["You’ve hit your limit · resets Oct 13"],
      },
    ],
    [
      true,
      { api_error: "usage_limit_reached", errors: ["Usage credits exhausted"] },
    ],
    [
      false,
      { subtype: "error_max_budget_usd", errors: ["Exceeded max budget"] },
    ],
    [false, { subtype: "error_max_turns", result: "Maximum turns reached" }],
    [false, { errors: ["429 rate_limit_error: requests per minute exceeded"] }],
    [
      false,
      {
        result: "You've hit your limit",
        api_error: "model_requires_usage_credits",
      },
    ],
    [
      false,
      {
        is_error: false,
        result: "You've hit your limit · example in a README",
      },
    ],
  ];
  for (const [expected, result] of cases) {
    const parser = new CliEventParser("claude", () => {});
    feed(
      parser,
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1791849600 },
      },
      { type: "result", subtype: "success", is_error: true, ...result },
    );
    assert.equal(
      !!parser.finish(1).usageLimit,
      expected,
      JSON.stringify(result),
    );
  }
});

void test("quota warnings, tool output and recoverable throttles do not interrupt", () => {
  for (const backend of ["claude", "codex", "cursor"] as const) {
    const events: DriverEvent[] = [];
    const parser = new CliEventParser(backend, (event) => events.push(event));
    parser.line("You've hit your usage limit", "stderr");
    feed(
      parser,
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning" },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", content: "You've hit your usage limit" },
          ],
        },
      },
      { type: "error", message: "429 Too Many Requests; retrying" },
      {
        type: backend === "codex" ? "turn.completed" : "result",
        subtype: "success",
        is_error: false,
        result: "Quota exceeded is an error message",
      },
    );
    assert.equal(parser.finish(0).usageLimit, undefined);
    assert.equal(
      events.filter((event) => event.type === "usage-limit").length,
      0,
    );
  }
});

void test("Claude does not reuse a recovered refusal for a later unrelated failure", () => {
  for (const recovered of [true, false]) {
    const parser = new CliEventParser("claude", () => {});
    feed(parser, {
      type: "assistant",
      is_api_error_message: true,
      api_error: "usage_limit_reached",
      message: { content: [] },
    });
    if (recovered) {
      feed(parser, {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Fallback model succeeded" }],
        },
      });
    }

    feed(parser, {
      type: "result",
      subtype: recovered ? "error_during_execution" : "error_max_turns",
      is_error: true,
      errors: ["Unrelated terminal failure"],
    });
    assert.equal(parser.finish(1).usageLimit, undefined);
  }
});

void test("Claude legacy refusals do not inherit advisory limit/reset details", () => {
  for (const status of ["allowed_warning", "rejected"]) {
    const parser = new CliEventParser("claude", () => {});
    feed(
      parser,
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status,
          rateLimitType: "seven_day_opus",
          resetsAt: 1791849600,
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Fallback model succeeded" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "You've hit your limit · resets 10am",
      },
    );
    assert.deepEqual(parser.finish(1).usageLimit, {
      message: "You've hit your limit · resets 10am",
    });
  }
});

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
    .split("\n")) {
    parser.line(line, "stdout");
  }
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
      if (event.method === "session/update") {
        parser.update(object(event.params.update));
      }
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
    if (backend === "opencode") {
      // OpenCode reports cache reads beside inputTokens; totalTokens is their
      // sum with output.
      assert.deepEqual(
        turns.map((turn) => turn.usage),
        [
          { input: 6977, cachedInput: 6656, output: 9 },
          { input: 7015, cachedInput: 6656, output: 10 },
        ],
      );
    } else {
      assert.ok(
        turns.every((turn) => turn.usage === undefined),
        "context occupancy must not become token usage",
      );
    }
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
      .split("\n")) {
      parser.line(line, "stdout");
    }
    const result = parser.finish(0);
    assert.equal(result.exitInfo.error, undefined);
    assert.deepEqual(parseStructured(result.text), { code: 731 });
    assert.equal(result.usage?.output, backend === "codex" ? 311 : 286);
    assert.deepEqual(
      result.usage,
      backend === "codex"
        ? { input: 55046, cachedInput: 35328, output: 311 }
        : { input: 31209, cachedInput: 19736, output: 286 },
    );
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
  for (const line of events) {
    parser.line(line, "stdout");
  }
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
  assert.deepEqual(claude.finish(0).usage, {
    input: 310,
    cachedInput: 200,
    output: 2,
  });
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
      if (path === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = path;
      }
    }
  } finally {
    if (previous === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previous;
    }
  }
});

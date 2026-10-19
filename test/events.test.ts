import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { delimiter, dirname } from "node:path";
import { test } from "node:test";

import { codexModels, cursorModels, CliDriver } from "../src/drivers/cli.js";
import {
  AcpEventParser,
  ClaudeEventParser,
  CodexEventParser,
  CursorEventParser,
  object,
} from "../src/drivers/events.js";
import type { CliEventParser } from "../src/drivers/events.js";
import { parseStructured } from "../src/runtime/schema.js";
import type { DriverEvent } from "../src/types.js";
import {
  fixtureLines,
  fixturePath,
  installFake,
  setEnv,
  tempDir,
} from "./helpers/common.js";

const parsers = {
  claude: ClaudeEventParser,
  codex: CodexEventParser,
  cursor: CursorEventParser,
};

async function replayFixture(backend: keyof typeof parsers, name: string) {
  const events: DriverEvent[] = [];
  const parser = new parsers[backend]((event) => events.push(event));
  for (const line of await fixtureLines(name)) {
    parser.line(line, "stdout");
  }
  return { parser, events };
}

function feed(parser: CliEventParser, ...events: unknown[]) {
  for (const event of events) {
    parser.line(JSON.stringify(event), "stdout");
  }
}

void test("recorded Claude, Codex and Cursor streams yield final output and usage", async () => {
  const claude = await replayFixture("claude", "claude-success.jsonl");
  const result = claude.parser.finish(0);
  assert.equal(result.exitInfo.error, undefined);
  assert.deepEqual(result.structured, {
    greeting: "Ready to orchestrate your workflow",
  });
  // Claude reports cache writes beside input_tokens.
  assert.deepEqual(result.usage, { input: 17690, cachedInput: 0, output: 214 });
  assert.equal(
    claude.events.filter((event) => event.type === "tool").length,
    1,
  );

  for (const [backend, usage] of [
    ["codex", { input: 55046, cachedInput: 35328, output: 311 }],
    ["cursor", { input: 31209, cachedInput: 19736, output: 286 }],
  ] as const) {
    const { parser } = await replayFixture(backend, `${backend}-success.jsonl`);
    const finished = parser.finish(0);
    assert.equal(finished.exitInfo.error, undefined);
    assert.deepEqual(parseStructured(finished.text), { code: 731 });
    assert.deepEqual(finished.usage, usage);
  }
});

void test("recorded ACP streams keep each turn's final answer and only real usage", async () => {
  for (const backend of ["opencode", "kimi", "qwen"]) {
    const events: DriverEvent[] = [];
    const parser = new AcpEventParser((event) => events.push(event));
    const turns = [];
    for (const line of await fixtureLines(`acp-${backend}.jsonl`)) {
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
    assert.equal(events.filter((event) => event.type === "tool").length, 1);
    // Only OpenCode reports per-turn tokens; the others report context
    // occupancy, which must not become usage.
    assert.deepEqual(
      turns.map((turn) => turn.usage),
      backend === "opencode"
        ? [
            { input: 6977, cachedInput: 6656, output: 9 },
            { input: 7015, cachedInput: 6656, output: 10 },
          ]
        : [undefined, undefined],
      backend,
    );
  }
});

void test("recorded model catalogs keep listed models and representable efforts", async () => {
  const codex = codexModels(
    await readFile(fixturePath("codex-models.json"), "utf8"),
  );
  assert.deepEqual(
    codex.map((model) => model.id),
    ["gpt-6-astra", "gpt-5.5"],
  );
  assert.deepEqual(codex[0]?.efforts, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  // Catalog order does not prove the user's configured default.
  assert.ok(codex.every((model) => !model.default));

  const cursor = cursorModels(
    await readFile(fixturePath("cursor-models.txt"), "utf8"),
  );
  assert.equal(cursor.length, 5);
  assert.equal(cursor.find((model) => model.default)?.id, "auto");
  assert.ok(cursor.some((model) => model.id === "gpt-5.6-sol-xhigh"));
});

void test("recorded quota refusals interrupt once and keep the vendor's details", async () => {
  const claude = await replayFixture("claude", "claude-usage-limit.jsonl");
  const claudeLimit = claude.parser.finish(1, undefined, "stderr").usageLimit;
  assert.equal(claudeLimit?.limit, "seven_day_opus");
  assert.equal(claudeLimit?.resetsAt, "2026-10-13T00:00:00.000Z");
  assert.equal(
    claude.events.filter((event) => event.type === "usage-limit").length,
    1,
  );

  const codex = await replayFixture("codex", "codex-usage-limit.jsonl");
  const codexResult = codex.parser.finish(1, undefined, "stderr");
  assert.match(
    codexResult.usageLimit?.message ?? "",
    /Oct 13th, 2026 10:00 AM/,
  );
  assert.equal(codexResult.exitInfo.error, codexResult.usageLimit?.message);
  // The vendor's reset text has no timezone; do not invent one.
  assert.equal(codexResult.usageLimit?.resetsAt, undefined);
});

void test("Claude classifies only failed terminal refusals as usage limits", () => {
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
    [true, { api_error: "usage_limit_reached", errors: ["Credits exhausted"] }],
    [false, { subtype: "error_max_budget_usd", errors: ["Exceeded budget"] }],
    [false, { subtype: "error_max_turns", result: "Maximum turns reached" }],
    [false, { errors: ["429 rate_limit_error: requests per minute exceeded"] }],
    [
      false,
      {
        result: "You've hit your limit",
        api_error: "model_requires_usage_credits",
      },
    ],
    [false, { is_error: false, result: "You've hit your limit · in a README" }],
  ];
  for (const [expected, result] of cases) {
    const parser = new ClaudeEventParser(() => {});
    // A rejected rate-limit event alone does not make a failure a refusal.
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

  // A refusal the harness recovered from is not reused for a later failure.
  const recovered = new ClaudeEventParser(() => {});
  feed(
    recovered,
    {
      type: "assistant",
      is_api_error_message: true,
      api_error: "usage_limit_reached",
      message: { content: [] },
    },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Fallback succeeded" }] },
    },
    {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Unrelated terminal failure"],
    },
  );
  assert.equal(recovered.finish(1).usageLimit, undefined);
});

void test("quota warnings, tool output and recoverable throttles do not interrupt", () => {
  for (const backend of ["claude", "codex", "cursor"] as const) {
    const events: DriverEvent[] = [];
    const parser = new parsers[backend]((event) => events.push(event));
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
    assert.equal(parser.finish(0).usageLimit, undefined, backend);
    assert.ok(events.every((event) => event.type !== "usage-limit"));
  }
});

void test("missing token counters are reported as unknown, not zero", () => {
  for (const backend of ["claude", "codex", "cursor"] as const) {
    const parser = new parsers[backend](() => {});
    feed(parser, {
      type: backend === "codex" ? "turn.completed" : "result",
      result: "answer",
    });
    assert.equal(parser.finish(0).usage, undefined, backend);
  }
});

void test("failed CLI exits prefer the parsed error, then stderr, then the exit code", async (t) => {
  const failed = new ClaudeEventParser(() => {});
  feed(failed, {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["parsed failure"],
  });
  assert.equal(
    failed.finish(1, undefined, "noise").exitInfo.error,
    "parsed failure",
  );
  const silent = new ClaudeEventParser(() => {});
  feed(silent, { type: "result", subtype: "success", result: "done" });
  assert.equal(
    silent.finish(2, undefined, "\n").exitInfo.error,
    "Backend exited 2",
  );

  // Stderr reaches the report through a real process.
  const cwd = await tempDir("events");
  await installFake(cwd, "fake-claude", "claude");
  setEnv(t, { PATH: [cwd, dirname(process.execPath)].join(delimiter) });
  const result = await new CliDriver("claude").run({
    prompt: "fail with stderr",
    cwd,
    systemAppend: "test",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  assert.deepEqual(result.exitInfo, { code: 1, error: "stderr failure" });
});

void test("Claude minimal mode requires explicit API-key authentication", async (t) => {
  // An empty PATH keeps discovery from invoking any installed binary.
  setEnv(t, { PATH: "", ANTHROPIC_API_KEY: undefined });
  assert.equal(
    (await new CliDriver("claude").detect(process.cwd())).minimal,
    false,
  );
  process.env.ANTHROPIC_API_KEY = "offline-fixture";
  assert.equal(
    (await new CliDriver("claude").detect(process.cwd())).minimal,
    true,
  );
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { MuseEventParser } from "../src/drivers/events.js";
import { MuseDriver, museArguments } from "../src/drivers/muse.js";
import { parseStructured } from "../src/runtime/schema.js";
import type { DriverEvent, DriverRequest } from "../src/types.js";

function request(overrides: Partial<DriverRequest> = {}): DriverRequest {
  return {
    prompt: "task",
    cwd: "/repo",
    systemAppend: "preamble",
    signal: new AbortController().signal,
    onEvent: () => {},
    ...overrides,
  };
}

void test("recorded Muse stream yields structured text, tool activity, and no usage", async () => {
  const events: DriverEvent[] = [];
  const parser = new MuseEventParser((event) => events.push(event));
  for (const line of (
    await readFile(
      new URL("./fixtures/muse-success.jsonl", import.meta.url),
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
  assert.equal(result.usage, undefined);
  assert.deepEqual(
    events.filter((event) => event.type === "tool").map((event) => event.text),
    ["read_file"],
  );
});

void test("Muse failed housekeeping tasks do not fail a completed run", () => {
  const events: DriverEvent[] = [];
  const parser = new MuseEventParser((event) => events.push(event));
  // Shape from the quota-free echo provider with reminders enabled.
  parser.line(
    JSON.stringify({
      payload_type: "task.lifecycle.failed",
      payload: {
        kind: "task_lifecycle",
        task_id: "fixture-task",
        event: {
          kind: "failed",
          task_id: "fixture-task",
          reason:
            "invalid run configuration: provider does not support base instructions",
        },
      },
    }),
    "stdout",
  );
  parser.line(
    JSON.stringify({
      payload_type: "run.terminal.completed",
      payload: { terminal: "completed", text: "done", reason: null },
    }),
    "stdout",
  );

  const result = parser.finish(0);
  assert.equal(result.exitInfo.error, undefined);
  assert.equal(result.text, "done");
  assert.equal(events.filter((event) => event.type === "tool").length, 0);
});

void test("Muse failed terminal becomes the result error", () => {
  const parser = new MuseEventParser(() => {});
  parser.line(
    JSON.stringify({
      payload_type: "run.terminal.completed",
      payload: { terminal: "failed", reason: "API error 400" },
    }),
    "stdout",
  );
  assert.equal(parser.finish(1).exitInfo.error, "API error 400");
});

void test("Muse missing terminal is an error, not an empty success", () => {
  const parser = new MuseEventParser(() => {});
  assert.match(
    parser.finish(0).exitInfo.error ?? "",
    /without a terminal event/,
  );
});

void test("Muse arguments map model, effort, and native schema", () => {
  const argv = museArguments(
    request({
      model: "muse-spark-1.3",
      effort: "low",
      schema: { type: "object" },
    }),
    "/tmp/prompt.txt",
    "/tmp/schema.json",
  );
  assert.deepEqual(argv.slice(0, 2), ["exec", "--json"]);
  for (const flag of [
    "--disable-approval",
    "--disable-reminders",
    "--trust-workspace",
    "--no-session-log",
    "--disable-sandbox",
  ]) {
    assert.ok(argv.includes(flag), flag);
  }
  assert.deepEqual(
    argv.slice(argv.indexOf("--workspace"), argv.indexOf("--workspace") + 4),
    ["--workspace", "/repo", "--prompt-file", "/tmp/prompt.txt"],
  );
  assert.deepEqual(
    argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 6),
    [
      "--model",
      "muse-spark-1.3",
      "--reasoning-effort",
      "low",
      "--output-schema",
      "/tmp/schema.json",
    ],
  );
});

void test("Muse read-only composes disable flags; unsupported policies fail closed", () => {
  const readOnly = museArguments(
    request({ toolPolicy: "read-only" }),
    "/tmp/prompt.txt",
  );
  for (const flag of [
    "--disable-write",
    "--disable-shell",
    "--disable-web-tools",
  ]) {
    assert.ok(readOnly.includes(flag), flag);
  }
  assert.ok(
    !readOnly.includes("--disable-sandbox"),
    "read-only keeps the sandbox as defense in depth",
  );

  assert.throws(
    () =>
      museArguments(
        request({ toolPolicy: { allow: ["Read"] } }),
        "/tmp/prompt.txt",
      ),
    /cannot enforce allow\/deny/,
  );
  assert.throws(
    () => museArguments(request({ minimal: true }), "/tmp/prompt.txt"),
    /does not support minimal/,
  );
});

void test("Muse detection advertises turn corrections and unavailable usage", async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const detection = await new MuseDriver().detect(process.cwd());
    assert.equal(detection.available, false);
    assert.equal(detection.transport, "cli");
    assert.equal(detection.structured, "native");
    assert.equal(detection.correction, "turn");
    assert.equal(detection.worktree, true);
    assert.equal(detection.usage, false);
    assert.equal(detection.minimal, false);
    assert.deepEqual(detection.toolPolicies, ["read-only"]);
    assert.deepEqual(
      detection.models,
      [],
      "without a catalog, Workflow must not invent model IDs or efforts",
    );
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
});

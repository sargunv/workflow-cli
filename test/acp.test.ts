import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { AcpDriver } from "../src/drivers/acp.js";
import type { DriverEvent, DriverSession } from "../src/types.js";

async function fixture(t: TestContext, backend: "opencode" | "qwen") {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-acp-"));
  const binary = join(cwd, backend);
  await copyFile(new URL("./helpers/fake-acp.cjs", import.meta.url), binary);
  await chmod(binary, 0o755);
  const variables = [
    "PATH",
    "WORKFLOW_FIXTURE_ACP_LOG",
    "WORKFLOW_FIXTURE_ACP_CONFIGS",
    "WORKFLOW_FIXTURE_ACP_SESSION",
  ];
  const previous = variables.map((key) => [key, process.env[key]] as const);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  process.env.PATH = [cwd, dirname(process.execPath)].join(delimiter);
  const log = join(cwd, "requests.jsonl");
  process.env.WORKFLOW_FIXTURE_ACP_LOG = log;
  delete process.env.WORKFLOW_FIXTURE_ACP_CONFIGS;
  delete process.env.WORKFLOW_FIXTURE_ACP_SESSION;
  return {
    cwd,
    driver: new AcpDriver(backend),
    readRequests: async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

void test("ACP config, permissions and correction turns share one leaf session", async (t) => {
  const { cwd, driver, readRequests } = await fixture(t, "opencode");
  let session: DriverSession | undefined;
  try {
    const detection = await driver.detect(cwd);
    assert.equal(detection.available, true, detection.notes.join("; "));
    assert.equal(detection.correction, "session");
    assert.deepEqual(detection.models[0], {
      id: "fixture-small",
      default: true,
      efforts: ["low", "high"],
    });
    const events: DriverEvent[] = [];
    const first = await driver.run({
      prompt: "first turn",
      cwd,
      systemAppend: "test preamble",
      model: "fixture-large",
      effort: "high",
      keepSession: true,
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });
    session = first.session;
    assert.ok(session);
    assert.deepEqual(JSON.parse(first.text), { turn: 1, permission: "once" });
    const second = await session.prompt("correct the result only");
    assert.deepEqual(JSON.parse(second.text), { turn: 2, permission: "once" });
    assert.equal(first.usage?.output, 2);
    assert.equal(second.usage?.output, 4);
    assert.equal(events.filter((event) => event.type === "tool").length, 2);
    await session.close();
    session = undefined;
    const records = await readRequests();
    assert.equal(
      records.filter((record) => record.method === "session/new").length,
      2,
      "discovery plus one retained leaf session",
    );
    assert.deepEqual(
      records
        .filter((record) => record.method === "session/set_config_option")
        .map((record) => record.params.value),
      ["fixture-large", "high"],
    );
    assert.deepEqual(
      records
        .filter((record) => record.id === "unsupported-1")
        .map((record) => record.error.code),
      [-32601],
    );
  } finally {
    await session?.close();
  }
});

void test("Qwen configuration refresh rejects effort removed by model selection", async (t) => {
  const { cwd, driver, readRequests } = await fixture(t, "qwen");
  const events: DriverEvent[] = [];
  // Low is valid before model selection; Flash exposes only none/default.
  process.env.WORKFLOW_FIXTURE_ACP_SESSION = fileURLToPath(
    new URL("./fixtures/qwen-session-config.json", import.meta.url),
  );
  process.env.WORKFLOW_FIXTURE_ACP_CONFIGS = fileURLToPath(
    new URL("./fixtures/qwen-model-config.json", import.meta.url),
  );
  const qwenDiscovery = await driver.detect(cwd);
  assert.equal(qwenDiscovery.models.length, 17);
  assert.deepEqual(
    qwenDiscovery.models.find((model) => model.default),
    {
      id: "qwen3.8-max(openai)",
      default: true,
      efforts: ["low", "medium", "xhigh"],
    },
  );
  const changed = await driver.run({
    prompt: "model capability refresh",
    cwd,
    systemAppend: "test",
    model: "qwen3.6-flash(openai)",
    effort: "low",
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  assert.equal(changed.exitInfo.code, 0);
  assert.ok(
    events.some(
      (event) =>
        event.type === "warning" &&
        event.text?.includes("effort was not applied"),
    ),
  );
  const updatedRequests = await readRequests();
  assert.ok(
    updatedRequests.some(
      (record) =>
        record.method === "session/set_config_option" &&
        record.params.configId === "mode" &&
        record.params.value === "yolo",
    ),
  );
  assert.equal(
    updatedRequests.some(
      (record) =>
        record.method === "session/set_config_option" &&
        record.params.value === "low",
    ),
    false,
  );
});

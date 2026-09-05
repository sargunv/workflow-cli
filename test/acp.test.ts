import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { AcpDriver } from "../src/drivers/acp.js";
import type { DriverEvent, DriverSession } from "../src/types.js";

void test("ACP config, permissions and correction turns share one leaf session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-acp-"));
  const binary = join(cwd, "opencode");
  await copyFile(new URL("./helpers/fake-acp.cjs", import.meta.url), binary);
  await chmod(binary, 0o755);
  const previousPath = process.env.PATH;
  const previousLog = process.env.WORKFLOW_FIXTURE_ACP_LOG;
  const previousConfigs = process.env.WORKFLOW_FIXTURE_ACP_CONFIGS;
  delete process.env.WORKFLOW_FIXTURE_ACP_CONFIGS;
  process.env.PATH = [cwd, dirname(process.execPath)].join(delimiter);
  process.env.WORKFLOW_FIXTURE_ACP_LOG = join(cwd, "requests.jsonl");
  let session: DriverSession | undefined;
  try {
    const driver = new AcpDriver("opencode");
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
    const records = (await readFile(join(cwd, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
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
    // Replay the actual Qwen model-dependent config surfaces. Low was valid
    // before selection but the selected Flash model exposes only none/default.
    process.env.WORKFLOW_FIXTURE_ACP_CONFIGS = fileURLToPath(
      new URL("./fixtures/qwen-model-config.json", import.meta.url),
    );
    const qwenDiscovery = await new AcpDriver("opencode").detect(cwd);
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
    const updatedRequests = (
      await readFile(join(cwd, "requests.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
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
  } finally {
    await session?.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.WORKFLOW_FIXTURE_ACP_LOG;
    else process.env.WORKFLOW_FIXTURE_ACP_LOG = previousLog;
    if (previousConfigs === undefined)
      delete process.env.WORKFLOW_FIXTURE_ACP_CONFIGS;
    else process.env.WORKFLOW_FIXTURE_ACP_CONFIGS = previousConfigs;
  }
});

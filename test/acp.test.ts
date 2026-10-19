import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import { AcpDriver } from "../src/drivers/acp.js";
import type { DriverEvent, DriverRequest } from "../src/types.js";
import { fixturePath, installFake, setEnv, tempDir } from "./helpers/common.js";

async function fixture(
  t: TestContext,
  backend: "opencode" | "qwen",
  recorded?: { session: string; configs: string },
) {
  const cwd = await tempDir("acp");
  await installFake(cwd, "fake-acp", backend);
  const log = join(cwd, "requests.jsonl");
  setEnv(t, {
    PATH: [cwd, dirname(process.execPath)].join(delimiter),
    WORKFLOW_FIXTURE_ACP_LOG: log,
    WORKFLOW_FIXTURE_ACP_SESSION: recorded && fixturePath(recorded.session),
    WORKFLOW_FIXTURE_ACP_CONFIGS: recorded && fixturePath(recorded.configs),
  });
  const events: DriverEvent[] = [];
  const driver = new AcpDriver(backend);
  return {
    driver,
    events,
    request: (prompt: string, extra: Partial<DriverRequest> = {}) => ({
      prompt,
      cwd,
      systemAppend: "test",
      signal: new AbortController().signal,
      onEvent: (event: DriverEvent) => events.push(event),
      ...extra,
    }),
    detect: () => driver.detect(cwd),
    requests: async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

void test("ACP config, permissions and correction turns share one leaf session", async (t) => {
  const { driver, events, request, detect, requests } = await fixture(
    t,
    "opencode",
  );
  const detection = await detect();
  assert.equal(detection.available, true, detection.notes.join("; "));
  assert.equal(detection.correction, "session");
  assert.deepEqual(detection.models[0], {
    id: "fixture-small",
    default: true,
    efforts: ["low", "high"],
  });
  const first = await driver.run(
    request("first turn", {
      model: "fixture-large",
      effort: "high",
      keepSession: true,
    }),
  );
  const session = first.session;
  assert.ok(session);
  t.after(() => session.close());
  // The fake echoes its turn and the permission option it was granted.
  assert.deepEqual(JSON.parse(first.text), { turn: 1, permission: "once" });
  const second = await session.prompt("correct the result only");
  assert.deepEqual(JSON.parse(second.text), { turn: 2, permission: "once" });
  assert.equal(second.usage?.output, 4);
  assert.equal(events.filter((event) => event.type === "tool").length, 2);

  const records = await requests();
  const method = (name: string) =>
    records.filter((record) => record.method === name);
  // Discovery's session plus the one retained leaf session.
  assert.equal(method("session/new").length, 2);
  assert.deepEqual(
    method("session/set_config_option").map((record) => record.params.value),
    ["fixture-large", "high"],
  );
  // Unsupported client requests get an error reply rather than hanging the turn.
  assert.equal(
    records.find((record) => record.id === "unsupported-1")?.error.code,
    -32601,
  );
});

void test("recorded Qwen config: effort removed by model selection is not applied", async (t) => {
  const { driver, events, request, detect, requests } = await fixture(
    t,
    "qwen",
    { session: "qwen-session-config.json", configs: "qwen-model-config.json" },
  );
  const detection = await detect();
  assert.deepEqual(
    detection.models.find((model) => model.default),
    {
      id: "qwen3.8-max(openai)",
      default: true,
      efforts: ["low", "medium", "xhigh"],
    },
  );
  // Low is valid before model selection; Flash exposes only none/default.
  const result = await driver.run(
    request("refresh", { model: "qwen3.6-flash(openai)", effort: "low" }),
  );
  assert.equal(result.exitInfo.code, 0);
  assert.ok(events.some((event) => event.type === "warning"));
  const values = (await requests())
    .filter((record) => record.method === "session/set_config_option")
    .map((record) => record.params.value);
  assert.deepEqual(values, ["qwen3.6-flash(openai)", "yolo"]);
});

void test("ACP exits report stderr, or the exit code when stderr is empty", async (t) => {
  const { driver, request } = await fixture(t, "opencode");
  await assert.rejects(driver.run(request("exit with stderr")), {
    message: "stderr failure",
  });
  await assert.rejects(driver.run(request("exit silently")), {
    message: "ACP exited 3",
  });
});

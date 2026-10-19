import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { configSchema, loadConfig } from "../src/config.ts";
import { setEnv, tempDir } from "./helpers/common.ts";

void test("config rejects ambiguous, unbounded and harness-only settings", () => {
  for (const invalid of [
    { backend: "codex", defaults: { backend: "claude" } },
    { transport: { agentTimeoutMs: 0 } },
    { sandbox: { memoryBytes: -1 } },
    { profiles: { reviewer: { agentType: "Explore" } } },
    { profiles: { reviewer: { profile: "another" } } },
  ]) {
    assert.throws(() => configSchema.parse(invalid), JSON.stringify(invalid));
  }
  // Agents run without a deadline unless the user sets one.
  assert.equal(configSchema.parse({}).transport.agentTimeoutMs, null);
});

void test("local config merges object fields over global config", async (t) => {
  const root = await tempDir("config");
  const write = async (path: string, value: unknown) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), JSON.stringify(value));
  };
  await write("config/workflow/config.json", {
    backend: "codex",
    defaults: { effort: "low", model: "global-model" },
    transport: { agentTimeoutMs: 60_000, discoveryTimeoutMs: 1_000 },
    profiles: {
      reviewer: { effort: "high", toolPolicy: "read-only" },
      writer: { model: "writer-model" },
    },
    sharedPaths: [{ path: "node_modules", mode: "symlink" }],
  });
  await write("project/.workflow/config.json", {
    defaults: { effort: "medium" },
    transport: { agentTimeoutMs: 120_000 },
    profiles: { reviewer: { effort: "xhigh" } },
    sharedPaths: [{ path: ".env", mode: "copy" }],
  });
  setEnv(t, { XDG_CONFIG_HOME: join(root, "config") });
  const config = await loadConfig(join(root, "project"));
  assert.equal(config.backend, "codex");
  assert.deepEqual(config.defaults, {
    effort: "medium",
    model: "global-model",
  });
  assert.equal(config.transport.agentTimeoutMs, 120_000);
  assert.equal(config.transport.discoveryTimeoutMs, 1_000);
  assert.deepEqual(config.profiles, {
    reviewer: { effort: "xhigh", toolPolicy: "read-only" },
    writer: { model: "writer-model" },
  });
  // Arrays replace rather than concatenate.
  assert.deepEqual(config.sharedPaths, [{ path: ".env", mode: "copy" }]);
});

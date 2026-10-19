import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { configSchema, loadConfig } from "../src/config.js";
void test("backend selection has a single run-default location", () => {
  assert.throws(() =>
    configSchema.parse({ backend: "codex", defaults: { backend: "claude" } }),
  );
  assert.equal(
    configSchema.parse({
      backend: "codex",
      profiles: { reviewer: { backend: "claude" } },
    }).backend,
    "codex",
  );
});
void test("agents have no deadline unless one is configured", () => {
  assert.equal(configSchema.parse({}).transport.agentTimeoutMs, null);
});
void test("transport and sandbox overrides are bounded and explicit", () => {
  const config = configSchema.parse({
    transport: { agentTimeoutMs: 60_000 },
    sandbox: { memoryBytes: 128 * 1024 * 1024 },
    schemaStrategy: "prompted",
  });
  assert.equal(config.transport.agentTimeoutMs, 60_000);
  assert.equal(config.transport.discoveryTimeoutMs, 20_000);
  assert.equal(config.sandbox.memoryBytes, 128 * 1024 * 1024);
  assert.equal(config.sandbox.interruptChecks, 100_000);
  assert.throws(() => configSchema.parse({ transport: { agentTimeoutMs: 0 } }));
  assert.throws(() => configSchema.parse({ sandbox: { memoryBytes: -1 } }));
});

void test("profiles reject harness agentType and recursive profile selections", () => {
  assert.throws(() =>
    configSchema.parse({ profiles: { reviewer: { agentType: "Explore" } } }),
  );
  assert.throws(() =>
    configSchema.parse({ profiles: { reviewer: { profile: "another" } } }),
  );
});

void test("local config merges object fields over global config", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workflow-config-"));
  const write = async (path: string, value: unknown) => {
    await mkdir(join(root, path, ".."), { recursive: true });
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
  const previous = process.env.XDG_CONFIG_HOME;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previous;
    }
  });
  process.env.XDG_CONFIG_HOME = join(root, "config");
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
  assert.deepEqual(config.sharedPaths, [{ path: ".env", mode: "copy" }]);
});

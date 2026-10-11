import assert from "node:assert/strict";
import { test } from "node:test";

import { configSchema } from "../src/config.js";
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
  assert.equal(config.sandbox.instructions, 100_000);
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

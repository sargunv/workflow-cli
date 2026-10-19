import { loadConfig } from "./config.ts";
import { createDrivers } from "./drivers/index.ts";
import { notice } from "./notice.ts";
import { agentCap, itemsPerCall, stackBytes } from "./runtime/limits.ts";
import type { Detection, ModelInfo } from "./types.ts";

export async function inspectInstallation(cwd: string) {
  const config = await loadConfig(cwd);
  const drivers = createDrivers(config.transport);
  const backends = await Promise.all(
    Object.values(drivers).map((driver) => driver.detect(cwd)),
  );
  const runtime = {
    scriptAPI: [
      "agent",
      "pipeline",
      "parallel",
      "phase",
      "log",
      "args",
      "budget",
      "workflow",
    ],
    concurrency: config.concurrency,
    agentCap,
    itemsPerCall,
    defaultBackend: config.backend,
    defaults: config.defaults,
    transport: config.transport,
    sandbox: config.sandbox,
    schemaStrategy: config.schemaStrategy,
    schemaRetries: config.schemaRetries,
    budget: { total: null, spent: 0, remaining: "Infinity" },
    notice,
  };

  return { runtime, backends, profiles: config.profiles };
}

type InstallationInfo = Awaited<ReturnType<typeof inspectInstallation>>;

function formatModel(model: ModelInfo): string {
  let description = model.id;
  if (model.default) {
    description += " (default)";
  }

  if (model.efforts.length) {
    description += ` [${model.efforts.join(",")}]`;
  }

  return description;
}

function formatBackend(backend: Detection): string[] {
  const availability = backend.available ? "available" : "missing";
  const capabilities = [
    `transport ${backend.transport}`,
    `structured ${backend.structured}`,
    `correction ${backend.correction}`,
    `worktree ${backend.worktree ? "yes" : "no"}`,
    `tool policies ${backend.toolPolicies.join(", ") || "none"}`,
    `minimal ${backend.minimal}`,
    `usage ${backend.usage ? "reported" : "unavailable"}`,
  ];

  const lines = [
    `  ${backend.name.padEnd(10)} ${availability}  ${backend.version ?? ""}  ${backend.binary ?? ""}`,
    `    ${capabilities.join("; ")}`,
  ];
  if (backend.models.length) {
    lines.push(`    models ${backend.models.map(formatModel).join(", ")}`);
  }

  for (const note of backend.notes) {
    lines.push(`    ${note}`);
  }

  return lines;
}

export function formatInstallation(info: InstallationInfo): string {
  const { runtime, backends, profiles } = info;
  const { sandbox, transport } = runtime;
  const lines = [
    "runtime",
    `  script API       ${runtime.scriptAPI.join(", ")}`,
    `  concurrency      ${runtime.concurrency}`,
    `  agent cap        ${runtime.agentCap} per run`,
    `  items per call   ${runtime.itemsPerCall}`,
    `  default backend  ${runtime.defaultBackend}`,
    `  defaults         ${JSON.stringify(runtime.defaults)}`,
    "  budget           disabled (total: null)",
    `  sandbox          ${sandbox.memoryBytes} bytes, ${sandbox.interruptChecks} interrupt checks, ${stackBytes / 1024} KiB stack`,
    `  schema strategy  ${runtime.schemaStrategy}, ${runtime.schemaRetries} correction attempts`,
    `  agent timeout    ${transport.agentTimeoutMs === null ? "none" : `${transport.agentTimeoutMs}ms per attempt`}`,
    `  discovery timeout ${transport.discoveryTimeoutMs}ms`,
    `  launch timeout   ${transport.launchTimeoutMs}ms`,
    "",
    notice,
    "",
    "backends",
  ];

  for (const backend of backends) {
    lines.push(...formatBackend(backend));
  }

  lines.push("", "profiles");
  const entries = Object.entries(profiles);
  if (!entries.length) {
    lines.push("  none");
  }

  for (const [name, profile] of entries) {
    lines.push(`  ${name}  ${JSON.stringify(profile)}`);
  }

  return lines.join("\n") + "\n";
}

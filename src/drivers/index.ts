import { defaultTransport } from "../config.ts";
import type { TransportSettings } from "../config.ts";
import type { BackendName, Driver } from "../types.ts";
import { AcpDriver } from "./acp.ts";
import { CliDriver } from "./cli.ts";

export function createDrivers(
  transport: TransportSettings = defaultTransport,
): Record<BackendName, Driver> {
  return {
    claude: new CliDriver("claude", transport),
    codex: new CliDriver("codex", transport),
    cursor: new CliDriver("cursor", transport),
    opencode: new AcpDriver("opencode", transport),
    kimi: new AcpDriver("kimi", transport),
    qwen: new AcpDriver("qwen", transport),
  };
}

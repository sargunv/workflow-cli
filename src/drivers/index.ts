import { defaultTransport } from "../config.js";
import type { TransportSettings } from "../config.js";
import type { BackendName, Driver } from "../types.js";
import { AcpDriver } from "./acp.js";
import { CliDriver } from "./cli.js";
import { MuseDriver } from "./muse.js";

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
    muse: new MuseDriver(transport),
  };
}

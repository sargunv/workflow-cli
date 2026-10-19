import { readFileSync } from "node:fs";

import { z } from "zod";

// Resolves to the package root from both src/ and dist/.
const manifest = new URL("../package.json", import.meta.url);

export const version = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(manifest, "utf8"))).version;

import { readFile } from "node:fs/promises";
import { homedir, availableParallelism } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { agentOptions, backendName } from "./types.js";
export const transportSchema = z
  .object({
    agentTimeoutMs: z.number().int().min(50).max(86_400_000).default(900_000),
    discoveryTimeoutMs: z.number().int().min(50).max(300_000).default(20_000),
    launchTimeoutMs: z.number().int().min(50).max(3_600_000).default(120_000),
  })
  .strict();
export type TransportSettings = z.infer<typeof transportSchema>;
export const defaultTransport = transportSchema.parse({});
export const configSchema = z
  .object({
    backend: backendName.default("claude"),
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(16)
      .default(Math.max(1, Math.min(16, availableParallelism() - 2))),
    defaults: agentOptions
      .omit({ backend: true, profile: true, agentType: true })
      .strict()
      .default({}),
    transport: transportSchema.default(defaultTransport),
    sandbox: z
      .object({
        memoryBytes: z
          .number()
          .int()
          .min(1_048_576)
          .max(1_073_741_824)
          .default(67_108_864),
        instructions: z
          .number()
          .int()
          .min(100)
          .max(100_000_000)
          .default(100_000),
      })
      .strict()
      .default({ memoryBytes: 67_108_864, instructions: 100_000 }),
    schemaStrategy: z.enum(["auto", "prompted"]).default("auto"),
    profiles: z
      .record(
        z.string(),
        agentOptions
          .omit({ agentType: true, profile: true })
          .extend({ systemAppend: z.string().optional() })
          .strict(),
      )
      .default({}),
    sharedPaths: z
      .array(z.object({ path: z.string(), mode: z.enum(["copy", "symlink"]) }))
      .default([]),
    schemaRetries: z.number().int().min(0).max(5).default(2),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
async function readOptional(path: string): Promise<Record<string, unknown>> {
  try {
    return z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {};
    throw new Error(`Invalid config ${path}`, { cause: error });
  }
}
export async function loadConfig(cwd: string): Promise<Config> {
  const global = await readOptional(
    join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "workflow",
      "config.json",
    ),
  );
  const local = await readOptional(join(cwd, ".workflow", "config.json"));
  return configSchema.parse({ ...global, ...local });
}

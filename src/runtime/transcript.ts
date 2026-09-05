import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { runPath } from "./store.js";
const cacheLink = z
  .object({
    type: z.literal("cache-hit"),
    runId: z.string(),
    agentId: z.number().int().positive(),
  })
  .strict();
export async function readTranscript(
  root: string,
  runId: string,
  agentId: number,
  visited = new Set<string>(),
): Promise<string> {
  if (!Number.isInteger(agentId) || agentId < 1) {
    throw new Error("Agent ID must be positive");
  }
  const key = `${runId}/${agentId}`;
  if (visited.has(key) || visited.size >= 100) {
    throw new Error("Invalid or excessively deep cached transcript lineage");
  }
  visited.add(key);
  const text = await readFile(
    join(runPath(root, runId), "transcripts", `${agentId}.jsonl`),
    "utf8",
  );
  const lines = text.trim().split("\n");
  if (lines.length === 1) {
    let value: unknown;
    try {
      value = JSON.parse(lines[0] ?? "");
    } catch {
      return text;
    }
    const link = cacheLink.safeParse(value);
    if (link.success) {
      return (
        text +
        (await readTranscript(
          root,
          link.data.runId,
          link.data.agentId,
          visited,
        ))
      );
    }
  }
  return text;
}

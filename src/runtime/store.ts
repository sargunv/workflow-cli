import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { agentOptions, agentRecord, jsonValue, metadata } from "../types.js";
import type { AgentRecord, Json, Metadata } from "../types.js";
export const activeAgentSchema = z.object({
  id: z.number().int().positive(),
  prompt: z.string(),
  options: agentOptions,
  key: z.string(),
  phase: z.string(),
  status: z.enum(["queued", "running"]),
  startedAt: z.string(),
  elapsedMs: z.number(),
  toolCalls: z.number(),
  activity: z.string().optional(),
});
export type ActiveAgent = z.infer<typeof activeAgentSchema>;
export const reportSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  directory: z.string(),
  scriptPath: z.string(),
  cwd: z.string(),
  meta: metadata,
  status: z.enum([
    "running",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  pid: z.number().int(),
  startedAt: z.string(),
  durationMs: z.number(),
  agents: z.array(agentRecord),
  activeAgents: z.array(activeAgentSchema).default([]),
  observation: z.string().optional(),
  logs: z.array(z.string()),
  result: jsonValue,
  error: z.string().optional(),
  resume: z.string().optional(),
});
export type Report = z.infer<typeof reportSchema>;

export function atomicJson(path: string, value: unknown) {
  const temporary = path + ".tmp";
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    flush: true,
    mode: 0o600,
  });
  renameSync(temporary, path);
}

export function runPath(root: string, id: string): string {
  if (!/^wf_[a-z0-9-]{6,}$/.test(id)) {
    throw new Error("Invalid run ID");
  }
  return join(root, id);
}

export function readReport(root: string, id: string): Report {
  return reportSchema.parse(
    JSON.parse(readFileSync(join(runPath(root, id), "report.json"), "utf8")),
  );
}

export class RunStore {
  readonly directory: string;
  readonly report: Report;
  constructor(
    root: string,
    source: string,
    args: Json,
    meta: Metadata,
    cwd: string,
    scriptPath: string,
    resume?: string,
  ) {
    const runId = `wf_${randomBytes(6).toString("hex")}`;
    this.directory = runPath(root, runId);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.directory, "transcripts"), { mode: 0o700 });
    writeFileSync(join(this.directory, "script.js"), source);
    atomicJson(join(this.directory, "args.json"), args);
    writeFileSync(join(this.directory, "journal.jsonl"), "");
    writeFileSync(join(this.directory, "replay.jsonl"), "");
    this.report = {
      version: 1,
      runId,
      directory: this.directory,
      scriptPath,
      cwd,
      meta,
      status: "running",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      agents: [],
      activeAgents: [],
      logs: [],
      result: null,
      resume,
    };
    this.save();
  }
  save() {
    atomicJson(join(this.directory, "report.json"), this.report);
  }
  agent(record: AgentRecord) {
    appendFileSync(
      join(this.directory, "journal.jsonl"),
      JSON.stringify(record) + "\n",
      { flush: true },
    );
    this.report.activeAgents = this.report.activeAgents.filter(
      (agent) => agent.id !== record.id,
    );
    this.report.agents.push(record);
    this.save();
  }
  startAgent(agent: ActiveAgent) {
    appendFileSync(
      join(this.directory, "invocations.jsonl"),
      JSON.stringify(agent) + "\n",
      { flush: true, mode: 0o600 },
    );
    this.report.activeAgents.push(agent);
    this.save();
  }
  transcript(id: number, event: unknown) {
    appendFileSync(
      join(this.directory, "transcripts", `${id}.jsonl`),
      JSON.stringify(event) + "\n",
    );
  }
}

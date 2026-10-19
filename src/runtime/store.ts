import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { Config } from "../config.ts";
import {
  agentOptions,
  agentRecord,
  backendName,
  jsonValue,
  metadata,
  usageLimit,
} from "../types.ts";
import type { AgentRecord, Json, Metadata } from "../types.ts";

const activeAgentSchema = z.object({
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

const reportSchema = z.object({
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
  usageLimit: usageLimit
    .extend({ backend: backendName, agentId: z.number().int().positive() })
    .optional(),
  resume: z.string().optional(),
});

export type Report = z.infer<typeof reportSchema>;

export function atomicJson(path: string, value: unknown, durable = true) {
  const temporary = path + ".tmp";
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    flush: durable,
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

interface RunStoreOptions {
  root: string;
  source: string;
  args: Json;
  config: Config;
  meta: Metadata;
  cwd: string;
  scriptPath: string;
  resume?: string;
}

/** Journals are append-and-flush evidence; report.json is an atomic snapshot.
 * invocations.jsonl records every accepted agent call, including calls with no
 * terminal result. journal.jsonl records only completed agents; transcripts
 * retain driver events. */
export class RunStore {
  readonly directory: string;

  readonly report: Report;

  private constructor(directory: string, report: Report) {
    this.directory = directory;
    this.report = report;
  }

  static async create(options: RunStoreOptions): Promise<RunStore> {
    const runId = `wf_${randomBytes(6).toString("hex")}`;
    const directory = runPath(options.root, runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(join(directory, "transcripts"), { mode: 0o700 });
    await writeFile(join(directory, "script.js"), options.source);
    await writeFile(join(directory, "journal.jsonl"), "");
    await writeFile(join(directory, "replay.jsonl"), "");
    atomicJson(join(directory, "args.json"), options.args);
    atomicJson(join(directory, "config.json"), options.config);
    const store = new RunStore(directory, {
      version: 1,
      runId,
      directory,
      scriptPath: options.scriptPath,
      cwd: options.cwd,
      meta: options.meta,
      status: "running",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      agents: [],
      activeAgents: [],
      logs: [],
      result: null,
      resume: options.resume,
    });
    store.save();

    return store;
  }

  /** Progress-only snapshots skip fsync; the next lifecycle save makes them durable. */
  save(durable = true) {
    atomicJson(join(this.directory, "report.json"), this.report, durable);
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

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ActiveAgent, Report } from "./runtime/store.js";
import type { AgentRecord } from "./types.js";

export function terminalText(text: string): string {
  return Array.from(text, (char) => {
    const point = char.codePointAt(0) ?? 0;

    return point < 32 || (point >= 127 && point <= 159) ? " " : char;
  }).join("");
}

function terminalMultiline(text: string): string {
  return text
    .split("\n")
    .map((line) => line.split("\t").map(terminalText).join("\t"))
    .join("\n");
}

function prepareResultDisplay(report: Report): {
  result?: unknown;
  resultPath?: string;
  preview?: string;
} {
  const text = JSON.stringify(report.result, null, 2);
  if (Buffer.byteLength(text) <= 16_384) {
    return { result: report.result };
  }

  const resultPath = join(report.directory, "result.json");
  writeFileSync(resultPath, text + "\n", { mode: 0o600 });
  // Slice on code points so a UTF-8 boundary never leaves a replacement character.
  let preview = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 4096) {
      break;
    }

    preview += char;
    bytes += size;
  }

  return { resultPath, preview };
}

/** Build the compact display payload, writing oversized results to result.json. */
export function prepareReport(report: Report) {
  const counts = {
    done: 0,
    errored: 0,
    skipped: 0,
    empty: 0,
    cached: 0,
    queued: 0,
    running: 0,
  };

  let input = 0;
  // Known only when every agent that reported usage reported its cache share.
  let cachedInput: number | undefined;
  let cacheUnknown = false;
  let output = 0;
  let tools = 0;
  let unreported = 0;
  let cachedTools = 0;
  for (const agent of report.agents) {
    counts[agent.status]++;
    if (agent.cached) {
      counts.cached++;
      cachedTools += agent.toolCalls;
    } else {
      tools += agent.toolCalls;
      if (agent.usage) {
        input += agent.usage.input;
        if (agent.usage.cachedInput === undefined) {
          cacheUnknown = true;
        } else {
          cachedInput = (cachedInput ?? 0) + agent.usage.cachedInput;
        }
        output += agent.usage.output;
      } else {
        unreported++;
      }
    }
  }

  for (const agent of report.activeAgents) {
    counts[agent.status]++;
  }

  const durationMs =
    report.status === "running"
      ? Math.max(0, Date.now() - Date.parse(report.startedAt))
      : report.durationMs;

  return {
    runId: report.runId,
    status: report.status,
    name: report.meta.name,
    description: report.meta.description,
    counts,
    tokens: {
      input,
      cachedInput: cacheUnknown ? undefined : cachedInput,
      output,
      unreportedAgents: unreported,
    },
    toolCalls: tools,
    cachedToolCalls: cachedTools,
    durationMs: Math.round(durationMs),
    directory: report.directory,
    logs: report.logs,
    error: report.error,
    usageLimit: report.usageLimit,
    observation: report.observation,
    ...prepareResultDisplay(report),
  };
}

function agentRow(
  agent: AgentRecord | ActiveAgent,
  cached: boolean,
  elapsedMs: number,
  reason: string | undefined,
  worktree?: AgentRecord["worktree"],
) {
  return {
    id: agent.id,
    phase: agent.phase,
    label: agent.options.label ?? `Agent ${agent.id}`,
    backend: agent.options.backend,
    model: agent.options.model,
    status: agent.status,
    cached,
    elapsedMs: Math.round(elapsedMs),
    toolCalls: agent.toolCalls,
    reason,
    worktree,
  };
}

export function agentTable(report: Report) {
  return [
    ...report.agents.map((agent) =>
      agentRow(
        agent,
        agent.cached,
        agent.durationMs,
        agent.reason,
        agent.worktree,
      ),
    ),
    ...report.activeAgents.map((agent) =>
      agentRow(agent, false, agent.elapsedMs, agent.activity),
    ),
  ].sort((a, b) => a.id - b.id);
}

type PreparedReport = ReturnType<typeof prepareReport>;

/** Pure formatting; prepareReport owns any result-file writes. */
export function formatReport(
  report: Report,
  summary: PreparedReport,
  details = false,
): string {
  const { counts, tokens } = summary;
  const statuses = [
    `${counts.done} done`,
    `${counts.errored} errored`,
    `${counts.skipped} skipped`,
    `${counts.empty} empty`,
    `${counts.cached} cached`,
  ];

  if (report.activeAgents.length) {
    statuses.push(`${counts.running} running`, `${counts.queued} queued`);
  }

  const cached =
    tokens.cachedInput === undefined ? "" : ` (${tokens.cachedInput} cached)`;
  let usage = `${tokens.input} input tokens${cached} · ${tokens.output} output tokens`;
  if (tokens.unreportedAgents) {
    usage += ` (${tokens.unreportedAgents} agents without usage)`;
  }

  const activity = [
    usage,
    `${summary.toolCalls} tool calls`,
    `${(summary.durationMs / 1000).toFixed(1)}s`,
  ];
  const lines = [
    `${report.meta.name} · ${report.status} · ${report.runId}`,
    report.meta.description,
    statuses.join(" · "),
    activity.join(" · "),
    `Run: ${report.directory}`,
  ];

  if (report.error) {
    lines.push(`Error: ${report.error}`);
  }

  if (report.observation) {
    lines.push(`Observation: ${report.observation}`);
  }

  for (const message of report.logs) {
    lines.push(`› ${message}`);
  }

  if (details) {
    for (const row of agentTable(report)) {
      const columns = [
        row.id,
        row.phase,
        row.label,
        row.status + (row.cached ? " (cached)" : ""),
        `${(row.elapsedMs / 1000).toFixed(1)}s`,
        `${row.toolCalls} tools`,
      ];

      const notes = [];
      if (row.reason) {
        notes.push(row.reason);
      }

      if (row.worktree?.kept) {
        notes.push(row.worktree.path);
      }

      lines.push([columns.join("  "), ...notes].join(" · "));
    }
  }

  const prose = lines.map(terminalText).join("\n") + "\n";
  if (summary.resultPath) {
    return (
      prose +
      `Result: ${terminalText(summary.resultPath)}\nPreview:\n${terminalMultiline(summary.preview ?? "")}\n`
    );
  }

  if (report.status === "running") {
    return prose;
  }

  return (
    prose +
    `${typeof report.result === "string" ? terminalMultiline(report.result) : JSON.stringify(report.result, null, 2)}\n`
  );
}

export function printReport(report: Report, json: boolean, details = false) {
  const prepared = prepareReport(report);
  process.stdout.write(
    json
      ? JSON.stringify({
          type: "report",
          ...prepared,
          ...(details ? { agents: agentTable(report) } : {}),
        }) + "\n"
      : formatReport(report, prepared, details),
  );
}

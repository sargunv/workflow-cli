import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Report } from "./runtime/store.js";

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
    tokens: { input, output, unreportedAgents: unreported },
    toolCalls: tools,
    cachedToolCalls: cachedTools,
    durationMs: Math.round(durationMs),
    directory: report.directory,
    logs: report.logs,
    error: report.error,
    observation: report.observation,
    ...prepareResultDisplay(report),
  };
}

export function agentTable(report: Report) {
  return [
    ...report.agents.map((agent) => ({
      id: agent.id,
      phase: agent.phase,
      label: agent.options.label ?? `Agent ${agent.id}`,
      backend: agent.options.backend,
      model: agent.options.model,
      status: agent.status,
      cached: agent.cached,
      elapsedMs: Math.round(agent.durationMs),
      toolCalls: agent.toolCalls,
      reason: agent.reason,
      worktree: agent.worktree,
    })),
    ...report.activeAgents.map((agent) => ({
      id: agent.id,
      phase: agent.phase,
      label: agent.options.label ?? `Agent ${agent.id}`,
      backend: agent.options.backend,
      model: agent.options.model,
      status: agent.status,
      cached: false,
      elapsedMs: Math.round(agent.elapsedMs),
      toolCalls: agent.toolCalls,
      reason: agent.activity,
      worktree: undefined,
    })),
  ].sort((a, b) => a.id - b.id);
}
type PreparedReport = ReturnType<typeof prepareReport>;

/** Pure formatting; prepareReport owns any result-file writes. */
export function formatReport(
  report: Report,
  summary: PreparedReport,
  details = false,
): string {
  const lines = [
    `${report.meta.name} · ${report.status} · ${report.runId}`,
    report.meta.description,
    `${summary.counts.done} done · ${summary.counts.errored} errored · ${summary.counts.skipped} skipped · ${summary.counts.empty} empty · ${summary.counts.cached} cached${report.activeAgents.length ? ` · ${summary.counts.running} running · ${summary.counts.queued} queued` : ""}`,
    `${summary.tokens.output} reported output tokens${summary.tokens.unreportedAgents ? ` (${summary.tokens.unreportedAgents} agents without usage)` : ""} · ${summary.toolCalls} tool calls · ${(summary.durationMs / 1000).toFixed(1)}s`,
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
      lines.push(
        `${row.id}  ${row.phase}  ${row.label}  ${row.status}${row.cached ? " (cached)" : ""}  ${(row.elapsedMs / 1000).toFixed(1)}s  ${row.toolCalls} tools${row.reason ? " · " + row.reason : ""}${row.worktree?.kept ? " · " + row.worktree.path : ""}`,
      );
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

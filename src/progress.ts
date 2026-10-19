import { terminalText } from "./output.js";
import type { RunEvent } from "./runtime/run.js";
import type { Report } from "./runtime/store.js";

interface Row {
  id: number;
  label: string;
  phase: string;
  state: string;
  activity: string;
  started: number;
  elapsedMs?: number;
  tools: number;
}

export interface ProgressSurface {
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
  tty: boolean;
  columns: () => number;
  rows: () => number;
  now: () => number;
}

const terminal: ProgressSurface = {
  writeOut: (text) => {
    process.stdout.write(text);
  },
  writeErr: (text) => {
    process.stderr.write(text);
  },
  tty: !!process.stderr.isTTY,
  columns: () => process.stderr.columns ?? 100,
  rows: () => process.stderr.rows ?? 24,
  now: () => Date.now(),
};

function formatAgentRow(row: Row, now: number): string {
  const icons: Record<string, string> = {
    running: "●",
    queued: "○",
    done: "✓",
    errored: "✗",
    skipped: "–",
    empty: "∅",
  };

  const elapsedMs =
    row.elapsedMs ?? (row.state === "queued" ? 0 : now - row.started);
  const parts = [
    `  ${icons[row.state] ?? "·"} ${row.id} ${row.label}`,
    row.state,
    `${(elapsedMs / 1000).toFixed(1)}s`,
    `${row.tools} tools`,
  ];

  if (row.activity) {
    parts.push(row.activity);
  }

  return parts.join(" · ");
}

/** Activity is coalesced; lifecycle and narrator events are never dropped. */
export class Progress {
  private agents = new Map<number, Row>();

  private activity = new Map<number, RunEvent>();

  private lines = 0;

  private observed = new Map<number, string>();

  private observedActivity = new Map<number, string>();

  private observedLogs = 0;

  private dirty = false;

  private timer: NodeJS.Timeout;

  constructor(
    private json: boolean,
    private surface: ProgressSurface = terminal,
    intervalMs = 250,
  ) {
    this.timer = setInterval(() => this.flush(), intervalMs);
    this.timer.unref();
  }

  event(event: RunEvent) {
    if (event.type === "activity" && event.id !== undefined) {
      this.activity.set(event.id, event);
      this.updateRow(event);
      this.dirty = true;

      return;
    }

    if (event.id !== undefined) {
      const pending = this.activity.get(event.id);
      if (pending && this.json) {
        this.emit(pending);
      }

      this.activity.delete(event.id);
    }

    this.updateRow(event);
    this.dirty = true;
    if (this.json) {
      this.emit(event);

      return;
    }

    if (["log", "warning", "replay"].includes(event.type)) {
      if (this.surface.tty) {
        this.clear();
      }

      this.surface.writeErr(`› ${terminalText(event.text ?? "")}\n`);
    } else if (event.type === "agent-finished" && !this.surface.tty) {
      this.surface.writeErr(
        `[${event.id}] ${event.status ?? "done"}${event.text ? " · " + terminalText(event.text) : ""}\n`,
      );
    }
  }

  observe(report: Report) {
    for (const agent of report.activeAgents) {
      const status = this.observed.get(agent.id);
      if (!status) {
        this.event({
          type: "agent-queued",
          runId: report.runId,
          id: agent.id,
          label: agent.options.label ?? `Agent ${agent.id}`,
          phase: agent.phase,
        });
      }

      if (agent.status === "running" && status !== "running") {
        this.event({
          type: "agent-started",
          runId: report.runId,
          id: agent.id,
          elapsedMs: Math.max(
            0,
            this.surface.now() - Date.parse(agent.startedAt),
          ),
        });
      }

      const fingerprint = JSON.stringify([agent.activity, agent.toolCalls]);
      if (this.observedActivity.get(agent.id) !== fingerprint) {
        this.event({
          type: "activity",
          runId: report.runId,
          id: agent.id,
          text: agent.activity,
          toolCalls: agent.toolCalls,
        });
      }

      this.observed.set(agent.id, agent.status);
      this.observedActivity.set(agent.id, fingerprint);
    }

    // Polling can begin mid-run. Emit completions only for agents we observed
    // live; the final report supplies history without replaying old events.
    for (const agent of report.agents) {
      if (
        this.observed.has(agent.id) &&
        this.observed.get(agent.id) !== agent.status
      ) {
        this.event({
          type: "agent-finished",
          runId: report.runId,
          id: agent.id,
          status: agent.status,
          text: agent.reason,
          elapsedMs: agent.durationMs,
          toolCalls: agent.toolCalls,
        });
        this.observed.set(agent.id, agent.status);
      }
    }

    if (report.status === "running") {
      for (const message of report.logs.slice(this.observedLogs)) {
        this.event({ type: "log", runId: report.runId, text: message });
      }
    }

    this.observedLogs = report.logs.length;
  }

  flush() {
    if (this.json) {
      for (const event of this.activity.values()) {
        this.emit(event);
      }
    }

    this.activity.clear();
    if (
      !this.json &&
      this.surface.tty &&
      (this.dirty ||
        [...this.agents.values()].some((row) => row.state === "running"))
    ) {
      this.render();
    }

    this.dirty = false;
  }

  close() {
    clearInterval(this.timer);
    this.flush();
    if (this.surface.tty) {
      this.clear();
    }
  }

  private emit(event: RunEvent) {
    this.surface.writeOut(JSON.stringify(event) + "\n");
  }

  private updateRow(event: RunEvent) {
    if (event.id === undefined) {
      return;
    }

    const row = this.agents.get(event.id) ?? {
      id: event.id,
      label: event.label ?? `Agent ${event.id}`,
      phase: event.phase ?? "Workflow",
      state: "queued",
      activity: "",
      started: this.surface.now(),
      tools: 0,
    };

    if (event.type === "agent-started") {
      row.state = "running";
      row.started = this.surface.now() - (event.elapsedMs ?? 0);
    }

    if (event.type === "agent-finished") {
      row.state = event.status ?? "done";
      row.elapsedMs = event.elapsedMs ?? this.surface.now() - row.started;
    }

    if (event.text) {
      row.activity = terminalText(event.text).slice(0, 160);
    }

    if (event.toolCalls !== undefined) {
      row.tools = event.toolCalls;
    }

    this.agents.set(event.id, row);
  }

  private clear() {
    if (this.lines) {
      this.surface.writeErr(`\x1b[${this.lines}A\x1b[J`);
      this.lines = 0;
    }
  }

  private render() {
    this.clear();
    const groups = new Map<string, Row[]>();
    // Keep live rows visible; completed agents remain inspectable in show.
    const ordered = [...this.agents.values()].sort(
      (a, b) =>
        Number(["queued", "running"].includes(a.state)) -
          Number(["queued", "running"].includes(b.state)) || a.id - b.id,
    );
    for (const row of ordered) {
      const group = groups.get(row.phase) ?? [];
      group.push(row);
      groups.set(row.phase, group);
    }

    const lines: string[] = [];
    const live = (rows: Row[]) =>
      rows.some((row) => ["queued", "running"].includes(row.state));
    for (const [phase, rows] of [...groups].sort(
      ([, a], [, b]) => Number(live(a)) - Number(live(b)),
    )) {
      lines.push(phase);
      for (const row of rows) {
        lines.push(formatAgentRow(row, this.surface.now()));
      }
    }

    const maxRows = Math.max(3, this.surface.rows() - 4);
    const visible = lines.slice(-maxRows);
    if (lines.length > maxRows) {
      visible.unshift(
        `… ${lines.length - maxRows} earlier rows; workflow-cli show for all agents`,
      );
    }

    const width = Math.max(20, this.surface.columns() - 1);
    this.surface.writeErr(
      visible.map((line) => terminalText(line).slice(0, width)).join("\n") +
        (visible.length ? "\n" : ""),
    );
    this.lines = visible.length;
  }
}

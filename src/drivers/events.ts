import { z } from "zod";

import { jsonValue } from "../types.js";
import type { DriverEvent, DriverResult, Json, Usage } from "../types.js";
const record = z.record(z.string(), z.unknown());

export function object(value: unknown): Record<string, unknown> {
  const result = record.safeParse(value);
  return result.success ? result.data : {};
}

export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function decode(line: string): Record<string, unknown> | undefined {
  try {
    const result = record.safeParse(JSON.parse(line));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function usage(value: unknown): Usage | undefined {
  const tokens = object(value);
  const input = tokens.input_tokens ?? tokens.inputTokens ?? tokens.input;
  const output = tokens.output_tokens ?? tokens.outputTokens ?? tokens.output;
  if (
    typeof input !== "number" ||
    !Number.isFinite(input) ||
    input < 0 ||
    typeof output !== "number" ||
    !Number.isFinite(output) ||
    output < 0
  ) {
    return undefined;
  }
  return {
    input,
    output,
  };
}

export class CliEventParser {
  text = "";
  structured: Json | undefined;
  usage: Usage | undefined;
  error: string | undefined;
  terminal = false;
  private tools = new Set<string>();
  private cursorFinal: string | undefined;

  constructor(
    private backend: "claude" | "codex" | "cursor",
    private emit: (event: DriverEvent) => void,
  ) {}

  line(line: string, channel: "stdout" | "stderr") {
    this.emit({ type: "raw", raw: { channel, line } });
    if (channel !== "stdout") {
      return;
    }
    const event = decode(line);
    if (!event) {
      return;
    }
    if (this.backend === "codex") {
      this.codexEvent(event);
    } else {
      this.claudeOrCursorEvent(event);
    }
  }

  private codexEvent(event: Record<string, unknown>) {
    const item = object(event.item);
    if (event.type === "item.started" || event.type === "item.completed") {
      if (item.type === "agent_message" && event.type === "item.completed") {
        this.text = string(item.text);
        this.activity(this.text);
      } else if (
        item.type === "command_execution" ||
        item.type === "mcp_tool_call" ||
        item.type === "file_change" ||
        item.type === "web_search"
      ) {
        this.tool(
          string(item.id),
          string(item.command ?? item.tool ?? item.type),
        );
      }
    }
    if (event.type === "turn.completed") {
      this.terminal = true;
      this.usage = usage(event.usage);
    }
    if (event.type === "turn.failed" || event.type === "error") {
      this.error =
        string(object(event.error).message ?? event.message) ||
        "Codex turn failed";
    }
  }

  private claudeOrCursorEvent(event: Record<string, unknown>) {
    const message = object(event.message);
    if (event.type === "assistant") {
      if (this.backend === "cursor") {
        const parts = array(message.content)
          .map(object)
          .filter((part) => part.type === "text");
        if (parts.length) {
          this.cursorFinal = parts.map((part) => string(part.text)).join("");
        }
      }
      for (const content of array(message.content)) {
        const part = object(content);
        if (part.type === "text") {
          this.activity(string(part.text));
        }
        if (part.type === "tool_use") {
          this.tool(string(part.id), string(part.name));
        }
      }
    }
    if (event.type === "tool_call" && event.subtype === "started") {
      if (this.backend === "cursor") {
        this.cursorFinal = undefined;
      }
      this.tool(
        string(event.call_id),
        Object.keys(object(event.tool_call)).find((key) =>
          key.endsWith("ToolCall"),
        ) ?? "Tool call",
      );
    }
    if (event.type === "result") {
      this.terminal = true;
      this.text =
        this.backend === "cursor"
          ? (this.cursorFinal ?? string(event.result))
          : string(event.result);
      const parsed = jsonValue.safeParse(event.structured_output);
      if (parsed.success) {
        this.structured = parsed.data;
      }
      this.usage = usage(event.usage);
      if (this.backend === "claude" && this.usage) {
        const tokens = object(event.usage);
        this.usage.input +=
          number(tokens.cache_creation_input_tokens) +
          number(tokens.cache_read_input_tokens);
      }
      if (this.usage && typeof event.total_cost_usd === "number") {
        this.usage.cost = event.total_cost_usd;
      }
      if (
        event.is_error === true ||
        (event.subtype !== undefined && event.subtype !== "success")
      ) {
        this.error = this.text || string(event.subtype) || "Backend failed";
      }
    }
  }

  private activity(text: string) {
    if (text) {
      this.emit({ type: "activity", text: text.split("\n")[0]?.slice(0, 160) });
    }
  }

  private tool(id: string, text: string) {
    if (!this.tools.has(id)) {
      this.tools.add(id);
      this.emit({ type: "tool", id, text });
    }
  }

  finish(code: number, error?: string): DriverResult {
    return {
      text: this.text,
      structured: this.structured,
      usage: this.usage,
      exitInfo: {
        code,
        error:
          error ??
          this.error ??
          (!this.terminal
            ? "Backend exited without a terminal event"
            : undefined),
      },
    };
  }
}

export class AcpEventParser {
  private text = "";
  private tokenUsage: Usage | undefined;
  private tools = new Set<string>();

  constructor(private emit: (event: DriverEvent) => void) {}
  reset() {
    this.text = "";
    this.tokenUsage = undefined;
  }

  update(update: Record<string, unknown>) {
    if (update.sessionUpdate === "agent_message_chunk") {
      const chunk = string(object(update.content).text);
      this.text += chunk;
      this.emit({
        type: "activity",
        text: chunk.split("\n")[0]?.slice(0, 160),
      });
    } else if (update.sessionUpdate === "tool_call") {
      const id = string(update.toolCallId);
      if (!this.tools.has(id)) {
        this.tools.add(id);
        this.emit({ type: "tool", id, text: string(update.title) });
      }
    } else if (update.sessionUpdate === "usage_update") {
      const tokens = object(update.usage ?? update);
      // Context occupancy (used/size) is not per-turn token usage.
      if (
        tokens.outputTokens !== undefined ||
        tokens.output_tokens !== undefined
      ) {
        this.tokenUsage = usage(tokens);
      }
    }
  }

  finish(result: Record<string, unknown>): DriverResult {
    const tokens = object(result.usage);
    if (
      tokens.outputTokens !== undefined ||
      tokens.output_tokens !== undefined
    ) {
      this.tokenUsage = usage(tokens);
    }
    return {
      text: this.text,
      usage: this.tokenUsage,
      exitInfo: {
        code: result.stopReason === "end_turn" ? 0 : 1,
        error:
          result.stopReason === "end_turn"
            ? undefined
            : `ACP stopped: ${string(result.stopReason)}`,
      },
    };
  }
}

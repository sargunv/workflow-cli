import { z } from "zod";

import { jsonValue } from "../types.ts";
import type {
  DriverEvent,
  DriverResult,
  Json,
  Usage,
  UsageLimit,
} from "../types.ts";

const record = z.record(z.string(), z.unknown());

export function object(value: unknown): Record<string, unknown> {
  const result = record.safeParse(value);

  return result.success ? result.data : {};
}

export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
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

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function usage(value: unknown): Usage | undefined {
  const tokens = object(value);
  const input = count(
    tokens.input_tokens ?? tokens.inputTokens ?? tokens.input,
  );
  const output = count(
    tokens.output_tokens ?? tokens.outputTokens ?? tokens.output,
  );
  if (input === undefined || output === undefined) {
    return undefined;
  }

  // Codex counts cache reads inside input_tokens. Claude, Cursor and OpenCode
  // report cache reads and writes beside their input count instead.
  const separate = [
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "cachedReadTokens",
    "cachedWriteTokens",
  ].reduce((sum, key) => sum + (count(tokens[key]) ?? 0), 0);
  const cached = count(
    tokens.cached_input_tokens ??
      tokens.cache_read_input_tokens ??
      tokens.cacheReadTokens ??
      tokens.cachedReadTokens,
  );

  return {
    input: input + separate,
    output,
    ...(cached === undefined ? {} : { cachedInput: cached }),
  };
}

// Context occupancy (used/size) is not per-turn token usage.
function isTurnUsage(tokens: Record<string, unknown>): boolean {
  return (
    tokens.outputTokens !== undefined || tokens.output_tokens !== undefined
  );
}

/** Emits a one-line activity preview per message and each tool call once. */
class Progress {
  private tools = new Set<string>();

  private emit: (event: DriverEvent) => void;

  constructor(emit: (event: DriverEvent) => void) {
    this.emit = emit;
  }

  activity(text: string) {
    if (text) {
      this.emit({ type: "activity", text: text.split("\n")[0]?.slice(0, 160) });
    }
  }

  tool(id: string, text: string) {
    if (!this.tools.has(id)) {
      this.tools.add(id);
      this.emit({ type: "tool", id, text });
    }
  }
}

export abstract class CliEventParser {
  protected text = "";

  protected structured: Json | undefined;

  protected usage: Usage | undefined;

  protected error: string | undefined;

  protected terminal = false;

  protected progress: Progress;

  private usageLimit: UsageLimit | undefined;

  private emit: (event: DriverEvent) => void;

  constructor(emit: (event: DriverEvent) => void) {
    this.emit = emit;
    this.progress = new Progress(emit);
  }

  line(line: string, channel: "stdout" | "stderr") {
    this.emit({ type: "raw", raw: { channel, line } });
    if (channel !== "stdout") {
      return;
    }

    const event = decode(line);
    if (event) {
      this.event(event);
    }
  }

  finish(code: number, processError?: string, stderr = ""): DriverResult {
    let error = processError ?? this.error;
    if (error === undefined && code !== 0) {
      error = stderr.trim() || `Backend exited ${code}`;
    }

    if (error === undefined && !this.terminal) {
      error = "Backend exited without a terminal event";
    }

    return {
      text: this.text,
      structured: this.structured,
      usage: this.usage,
      usageLimit: this.usageLimit,
      exitInfo: { code, error },
    };
  }

  protected abstract event(event: Record<string, unknown>): void;

  protected recordUsageLimit(limit: UsageLimit) {
    if (!this.usageLimit) {
      this.usageLimit = limit;
      this.emit({ type: "usage-limit", usageLimit: limit });
    }
  }
}

export class CodexEventParser extends CliEventParser {
  protected event(event: Record<string, unknown>) {
    const item = object(event.item);
    if (event.type === "item.started" || event.type === "item.completed") {
      if (item.type === "agent_message" && event.type === "item.completed") {
        this.text = string(item.text);
        this.progress.activity(this.text);
      } else if (
        item.type === "command_execution" ||
        item.type === "mcp_tool_call" ||
        item.type === "file_change" ||
        item.type === "web_search"
      ) {
        this.progress.tool(
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
      // exec JSON drops the typed UsageLimitReached error, retaining its message.
      if (/^You[’']ve hit your usage limit\b/.test(this.error)) {
        this.recordUsageLimit({ message: this.error });
      }
    }
  }
}

/** Claude's stream-json format, which Cursor also emits. */
abstract class StreamJsonEventParser extends CliEventParser {
  protected event(event: Record<string, unknown>) {
    if (event.type === "assistant") {
      for (const content of array(object(event.message).content)) {
        const part = object(content);
        if (part.type === "text") {
          this.progress.activity(string(part.text));
        }

        if (part.type === "tool_use") {
          this.progress.tool(string(part.id), string(part.name));
        }
      }
    }

    if (event.type === "tool_call" && event.subtype === "started") {
      this.progress.tool(
        string(event.call_id),
        Object.keys(object(event.tool_call)).find((key) =>
          key.endsWith("ToolCall"),
        ) ?? "Tool call",
      );
    }

    if (event.type === "result") {
      this.result(event);
    }
  }

  protected resultText(event: Record<string, unknown>): string {
    return string(event.result);
  }

  protected failed(_event: Record<string, unknown>) {}

  private result(event: Record<string, unknown>) {
    this.terminal = true;
    this.text = this.resultText(event);
    const parsed = jsonValue.safeParse(event.structured_output);
    if (parsed.success) {
      this.structured = parsed.data;
    }

    this.usage = usage(event.usage);

    if (this.usage && typeof event.total_cost_usd === "number") {
      this.usage.cost = event.total_cost_usd;
    }

    if (
      event.is_error === true ||
      (event.subtype !== undefined && event.subtype !== "success")
    ) {
      this.error =
        array(event.errors).map(string).filter(Boolean).join("\n") ||
        this.text ||
        string(event.subtype) ||
        "Backend failed";
      this.failed(event);
    }
  }
}

export class ClaudeEventParser extends StreamJsonEventParser {
  private apiError: Record<string, unknown> | undefined;

  protected event(event: Record<string, unknown>) {
    if (event.type === "assistant") {
      this.apiError = event.is_api_error_message === true ? event : undefined;
    }

    super.event(event);
  }

  protected failed(event: Record<string, unknown>) {
    if (
      [
        "error_max_turns",
        "error_max_budget_usd",
        "error_max_structured_output_retries",
      ].includes(string(event.subtype))
    ) {
      return;
    }

    const apiError = this.apiError ?? {};
    const typed = event.api_error ?? apiError.api_error;
    const message = this.error ?? "Claude usage limit reached";
    // A rate_limit_event is advisory: overage, grace or fallback may still succeed.
    // Only classify a failed terminal result, using the typed refusal when present.
    if (
      typed !== "usage_limit_reached" &&
      (typed !== undefined ||
        !/^You[’']ve hit your (?:usage )?limit\b/.test(message))
    ) {
      return;
    }

    // Advisory state can belong to a prior model or request after fallback.
    // Only the refusal's own parameters identify its limit and reset reliably.
    const details = object(object(apiError.api_error_params).rate_limit_info);
    const reset = details.resetsAt;
    const timestamp =
      typeof reset === "number" ? new Date(reset * 1000) : undefined;
    this.recordUsageLimit({
      message,
      ...(typeof details.rateLimitType === "string"
        ? { limit: details.rateLimitType }
        : {}),
      ...(timestamp && Number.isFinite(timestamp.getTime())
        ? { resetsAt: timestamp.toISOString() }
        : {}),
    });
  }
}

export class CursorEventParser extends StreamJsonEventParser {
  // Cursor's result joins every assistant message; the answer is the text after
  // the last tool call.
  private final: string | undefined;

  protected event(event: Record<string, unknown>) {
    if (event.type === "assistant") {
      const parts = array(object(event.message).content)
        .map(object)
        .filter((part) => part.type === "text");
      if (parts.length) {
        this.final = parts.map((part) => string(part.text)).join("");
      }
    }

    if (event.type === "tool_call" && event.subtype === "started") {
      this.final = undefined;
    }

    super.event(event);
  }

  protected resultText(event: Record<string, unknown>): string {
    return this.final ?? string(event.result);
  }
}

export class GrokEventParser extends StreamJsonEventParser {
  // Grok fills unknown spend with zeros (OAuth sessions never report cost), so
  // a zero means unreported, not free.
  protected event(event: Record<string, unknown>) {
    super.event(event);

    if (event.type === "result" && this.usage) {
      if (this.usage.input === 0 && this.usage.output === 0) {
        this.usage = undefined;
      } else if (this.usage.cost === 0) {
        delete this.usage.cost;
      }
    }
  }

  // Grok's result has no typed limit or reset, only the message: the free-tier
  // paywall text, or a 402/credit block whose text may lead with a limit slug.
  // A 429 that outlasts Grok's retry is a throttle, not a refusal.
  protected failed() {
    const message = this.error ?? "";
    if (
      !/^You[’']ve reached your free Grok Build usage limit\b/.test(message) &&
      !/\bstatus 402\b|spending-limit|out of credits|usage balance exhausted|usage limit reached/i.test(
        message,
      )
    ) {
      return;
    }

    const slug = /^([\w-]+:[\w-]+): /.exec(message)?.[1];
    this.recordUsageLimit({ message, ...(slug ? { limit: slug } : {}) });
  }
}

export class AcpEventParser {
  private text = "";

  private tokenUsage: Usage | undefined;

  private progress: Progress;

  constructor(emit: (event: DriverEvent) => void) {
    this.progress = new Progress(emit);
  }

  reset() {
    this.text = "";
    this.tokenUsage = undefined;
  }

  update(update: Record<string, unknown>) {
    if (update.sessionUpdate === "agent_message_chunk") {
      const chunk = string(object(update.content).text);
      this.text += chunk;
      this.progress.activity(chunk);
    } else if (update.sessionUpdate === "tool_call") {
      this.progress.tool(string(update.toolCallId), string(update.title));
    } else if (update.sessionUpdate === "usage_update") {
      const tokens = object(update.usage ?? update);
      if (isTurnUsage(tokens)) {
        this.tokenUsage = usage(tokens);
      }
    }
  }

  finish(result: Record<string, unknown>): DriverResult {
    const tokens = object(result.usage);
    if (isTurnUsage(tokens)) {
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

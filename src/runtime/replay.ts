import { appendFileSync, readFileSync } from "node:fs";

import { z } from "zod";

import { jsonValue } from "../types.js";
import type { Json } from "../types.js";

const traceEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    id: z.number().int().positive(),
    key: z.string(),
  }),
  z.object({
    type: z.literal("finish"),
    id: z.number().int().positive(),
    value: jsonValue,
  }),
]);

export type TraceEvent = z.infer<typeof traceEvent>;

export function readTrace(path: string): TraceEvent[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const events: TraceEvent[] = [];
  const started = new Set<number>();
  const finished = new Set<number>();
  for (const [index, line] of lines.entries()) {
    if (!line && index === lines.length - 1) {
      continue;
    }

    let event: TraceEvent;
    try {
      event = traceEvent.parse(JSON.parse(line));
    } catch (error) {
      // Only a torn final append can be recovered. Never hide middle corruption.
      if (index === lines.length - 1 && !text.endsWith("\n")) {
        break;
      }

      throw new Error(`Invalid replay journal line ${index + 1}`, {
        cause: error,
      });
    }

    if (event.type === "start") {
      if (started.has(event.id)) {
        throw new Error("Duplicate replay invocation");
      }

      started.add(event.id);
    } else {
      if (!started.has(event.id) || finished.has(event.id)) {
        throw new Error("Invalid replay completion");
      }

      finished.add(event.id);
    }

    events.push(event);
  }

  return events;
}

interface Pending {
  currentInvocationId: number;
  value: Json;
  resolve: (value: { value: Json; cached: boolean }) => void;
  reject: (error: unknown) => void;
}

/** Invocation identity and delivery order are separate. A cache hit must preserve
 * delivery order, or no-barrier pipelines change their subsequent prompts. */
export class Replay {
  private traceIndex = 0;

  private nextInvocationId = 0;

  private replaying: boolean;

  // Keys are IDs in the previous run; each value carries its new-run ID.
  private pending = new Map<number, Pending>();

  private scheduled = false;

  private failure: unknown;

  private preparations = 0;

  private terminals = new Map<number, Json>();

  constructor(
    private path: string,
    private previous: TraceEvent[] = [],
    private onDiverge: (reason: string) => void = () => {},
  ) {
    this.replaying = previous.length > 0;
    for (const event of previous) {
      if (event.type === "finish") {
        this.terminals.set(event.id, event.value);
      }
    }
  }

  holdPreparation(): () => void {
    this.preparations++;
    let released = false;

    return () => {
      if (!released) {
        released = true;
        this.preparations--;
        this.schedule();
      }
    };
  }

  call(
    key: string,
    live: () => Promise<Json>,
    cacheCompletion: () => boolean = () => true,
  ): Promise<{ value: Json; cached: boolean }> {
    if (this.failure) {
      throw this.failure;
    }

    const id = ++this.nextInvocationId;
    this.write({ type: "start", id, key });
    const expected = this.previous[this.traceIndex];
    if (
      this.replaying &&
      expected?.type === "start" &&
      expected.key === key &&
      this.terminals.has(expected.id)
    ) {
      this.traceIndex++;
      const previousId = expected.id;
      const value = this.terminals.get(previousId) ?? null;

      return new Promise((resolve, reject) => {
        this.pending.set(previousId, {
          currentInvocationId: id,
          value,
          resolve,
          reject,
        });
        this.schedule();
      });
    }

    if (this.replaying) {
      this.diverge(
        "First changed, new, or unfinished call; subsequent agents run live",
      );
    }

    return live().then((value) => {
      if (cacheCompletion()) {
        this.write({ type: "finish", id, value });
      }

      return { value, cached: false };
    });
  }

  private write(event: TraceEvent) {
    appendFileSync(this.path, JSON.stringify(event) + "\n", { flush: true });
  }

  private diverge(reason: string) {
    this.replaying = false;
    this.onDiverge(reason);
    this.schedule();
  }

  private schedule() {
    if (this.scheduled || this.failure) {
      return;
    }

    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      try {
        this.pump();
      } catch (error) {
        this.failure = error;
        for (const pending of this.pending.values()) {
          pending.reject(error);
        }

        this.pending.clear();
      }
    });
  }

  private pump() {
    if (!this.pending.size) {
      return;
    }

    let next: Pending | undefined;
    if (this.replaying) {
      const event = this.previous[this.traceIndex];
      if (event?.type === "finish") {
        next = this.pending.get(event.id);
        if (next) {
          this.pending.delete(event.id);
          this.traceIndex++;
        } else {
          this.diverge("Replay completion has no matching pending invocation");
        }
      } else {
        if (this.preparations) {
          return;
        }

        // Every guest drains its microtasks before this macrotask. If the old next
        // invocation never arrived, an edited branch would otherwise deadlock.
        this.diverge(
          "Edited control flow no longer reaches the next cached invocation",
        );
      }
    }

    if (!this.replaying && !next) {
      // Preserve original delivery order for the already matched prefix.
      for (const event of this.previous) {
        if (event.type === "finish" && this.pending.has(event.id)) {
          next = this.pending.get(event.id);
          this.pending.delete(event.id);
          break;
        }
      }
    }

    if (next) {
      try {
        this.write({
          type: "finish",
          id: next.currentInvocationId,
          value: next.value,
        });
      } catch (error) {
        next.reject(error);
        throw error;
      }

      next.resolve({ value: next.value, cached: true });
    }

    if (this.pending.size) {
      this.schedule();
    }
  }
}

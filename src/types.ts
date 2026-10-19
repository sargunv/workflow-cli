import { z } from "zod";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export const jsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

export const backendName = z.enum([
  "claude",
  "codex",
  "opencode",
  "kimi",
  "cursor",
  "qwen",
]);

export type BackendName = z.infer<typeof backendName>;

export const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const toolPolicy = z.union([
  z.literal("read-only"),
  z
    .object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .strict(),
]);

export const agentOptions = z
  .object({
    label: z.string().optional(),
    phase: z.string().optional(),
    schema: z.record(z.string(), jsonValue).optional(),
    model: z.string().min(1).optional(),
    backend: backendName.optional(),
    effort: effort.optional(),
    isolation: z.literal("worktree").optional(),
    profile: z.string().optional(),
    agentType: z.string().optional(),
    toolPolicy: toolPolicy.optional(),
    minimal: z.boolean().optional(),
  })
  .strict();

export type AgentOptions = z.infer<typeof agentOptions>;

export const metadata = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    whenToUse: z.string().optional(),
    phases: z
      .array(
        z
          .object({
            title: z.string().min(1),
            detail: z.string().optional(),
            model: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type Metadata = z.infer<typeof metadata>;

export const usage = z.object({
  input: z.number(),
  // The part of input that the backend served from its prompt cache.
  cachedInput: z.number().optional(),
  output: z.number(),
  cost: z.number().optional(),
});

export type Usage = z.infer<typeof usage>;

export interface DriverEvent {
  type: "activity" | "tool" | "usage" | "usage-limit" | "warning" | "raw";
  text?: string;
  id?: string;
  usage?: Usage;
  usageLimit?: UsageLimit;
  raw?: unknown;
}

export const usageLimit = z.object({
  message: z.string(),
  limit: z.string().optional(),
  resetsAt: z.string().optional(),
});

export type UsageLimit = z.infer<typeof usageLimit>;

export interface DriverRequest {
  prompt: string;
  cwd: string;
  model?: string;
  effort?: z.infer<typeof effort>;
  schema?: Record<string, Json>;
  systemAppend: string;
  toolPolicy?: z.infer<typeof toolPolicy>;
  minimal?: boolean;
  keepSession?: boolean;
  signal: AbortSignal;
  onEvent: (event: DriverEvent) => void;
}

export interface DriverResult {
  text: string;
  structured?: Json;
  usage?: Usage;
  usageLimit?: UsageLimit;
  exitInfo: { code: number; error?: string };
  session?: DriverSession;
}

export interface DriverSession {
  prompt(text: string): Promise<DriverResult>;
  close(): Promise<void>;
}

export class ProcessOwnershipError extends Error {
  override name = "ProcessOwnershipError";
}

export interface ModelInfo {
  id: string;
  default?: boolean;
  efforts: string[];
}

export interface Detection {
  name: BackendName;
  available: boolean;
  binary?: string;
  version?: string;
  notes: string[];
  transport: "cli" | "acp";
  models: ModelInfo[];
  structured: "native" | "prompted";
  correction: "session" | "turn";
  worktree: boolean;
  toolPolicies: string[];
  minimal: boolean;
  usage: boolean;
}

export interface Driver {
  detect(cwd: string, signal?: AbortSignal): Promise<Detection>;
  run(request: DriverRequest): Promise<DriverResult>;
}

export const worktreeRecord = z.object({
  path: z.string(),
  branch: z.string(),
  base: z.string(),
  kept: z.boolean(),
  ignoredBaseline: z.string().optional(),
});

export type WorktreeRecord = z.infer<typeof worktreeRecord>;

export const agentRecord = z.object({
  id: z.number().int(),
  kind: z.literal("agent"),
  prompt: z.string(),
  options: agentOptions,
  key: z.string(),
  phase: z.string(),
  status: z.enum(["done", "errored", "skipped", "empty"]),
  result: jsonValue,
  reason: z.string().optional(),
  cached: z.boolean(),
  startedAt: z.string(),
  durationMs: z.number(),
  usage: usage.optional(),
  toolCalls: z.number(),
  worktree: worktreeRecord.optional(),
});

export type AgentRecord = z.infer<typeof agentRecord>;

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Stable key ordering makes structurally equal JSON share a replay identity.
export function canonical(value: Json): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonical).join(",") + "]";
  }

  if (value !== null && typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key] ?? null))
        .join(",") +
      "}"
    );
  }

  return JSON.stringify(value);
}

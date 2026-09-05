import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import type { Config } from "../config.js";
import { isErrno } from "../types.js";
import {
  agentOptions,
  agentRecord,
  backendName,
  canonical,
  errorText,
  jsonValue,
} from "../types.js";
import type {
  AgentOptions,
  AgentRecord,
  BackendName,
  Driver,
  Detection,
  Json,
} from "../types.js";
import { AgentExecution } from "./agent.js";
import { startControl } from "./control.js";
import { Replay, readTrace } from "./replay.js";
import { executeScript } from "./sandbox.js";
import { compileSchema } from "./schema.js";
import { parseScript, readScriptFile } from "./script.js";
import type { Script } from "./script.js";
import { Semaphore } from "./semaphore.js";
import { atomicJson, RunStore, runPath } from "./store.js";
import type { Report } from "./store.js";

export interface RunEvent {
  type: string;
  runId?: string;
  id?: number;
  phase?: string;
  label?: string;
  text?: string;
  status?: string;
  elapsedMs?: number;
  toolCalls?: number;
}

export interface RunRequest {
  scriptPath: string;
  source: string;
  args: Json;
  cwd: string;
  root: string;
  config: Config;
  drivers: Record<BackendName, Driver>;
  resume?: string;
  signal: AbortSignal;
  onEvent: (event: RunEvent) => void;
  onStarting?: (run: WorkflowRun) => void | Promise<void>;
  onReady?: (run: WorkflowRun) => void | Promise<void>;
}

interface Scope {
  path: string;
  script: Script;
  backend: BackendName;
  child: boolean;
  phase: string;
}

const childArchive = z.array(
  z
    .object({
      path: z.string().refine(isAbsolute),
      file: z.string().regex(/^\d+\.js$/),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
);

function toJournalValue(record: AgentRecord): Json {
  // Optional record fields contain undefined; omit them at the JSON boundary.
  return jsonValue.parse(JSON.parse(JSON.stringify(record)));
}

/** Owns root admission, replay and durable records; live leaves own their resources. */
export class WorkflowRun {
  readonly store: RunStore;

  private readonly controller = new AbortController();

  private readonly semaphore: Semaphore;

  private readonly replay: Replay;

  private readonly detections = new Map<BackendName, Promise<Detection>>();

  private count = 0;

  private readonly pending = new Set<Promise<Json>>();

  private readonly controllers = new Map<number, AbortController>();

  private readonly scripts = new Map<string, Script>();

  private readonly childResolutions = new Map<string, string>();

  private readonly savedChildren = new Map<
    string,
    { file: string; sha256: string }
  >();

  private archivedChildren: z.infer<typeof childArchive> = [];

  private stopped = false;

  private failure: Error | undefined;

  private started = performance.now();

  private lastProgressSave = 0;

  constructor(
    private request: RunRequest,
    script: Script,
  ) {
    this.store = new RunStore(
      request.root,
      request.source,
      request.args,
      script.meta,
      request.cwd,
      request.scriptPath,
      request.resume,
    );
    atomicJson(join(this.store.directory, "config.json"), request.config);
    this.semaphore = new Semaphore(request.config.concurrency);
    this.replay = new Replay(
      join(this.store.directory, "replay.jsonl"),
      request.resume
        ? readTrace(join(runPath(request.root, request.resume), "replay.jsonl"))
        : [],
      (text) => this.event({ type: "replay", text }),
    );
  }

  async run(script: Script): Promise<Report> {
    const abort = () =>
      this.cancel(errorText(this.request.signal.reason ?? "Cancelled"));
    this.request.signal.addEventListener("abort", abort, { once: true });
    let finalStatus: Report["status"] = "failed";
    let closeControl: (() => Promise<void>) | undefined;
    try {
      this.request.signal.throwIfAborted();
      closeControl = await startControl(this.store.directory, {
        runId: this.store.report.runId,
        cancel: () => this.cancel(),
        skip: (id) => this.skip(id),
      });
      await this.request.onStarting?.(this);

      this.restoreChildArchives();
      await this.preflight(script, this.request.scriptPath);
      this.controller.signal.throwIfAborted();

      this.event({ type: "run-started", text: this.store.directory });
      await this.request.onReady?.(this);
      this.controller.signal.throwIfAborted();

      this.store.report.result = await this.execute(
        {
          script,
          path: this.request.scriptPath,
          backend: this.request.config.backend,
          child: false,
          phase: script.meta.phases?.[0]?.title ?? "Workflow",
        },
        this.request.args,
      );
      finalStatus = "completed";
    } catch (error) {
      finalStatus = this.controller.signal.aborted ? "cancelled" : "failed";
      this.store.report.error = errorText(error);
    } finally {
      this.stopped = true;
      if (this.pending.size) {
        this.controller.abort(
          new Error("Workflow ended before awaiting all agents"),
        );
      }

      await Promise.allSettled(this.pending);
      if (this.failure) {
        finalStatus = "failed";
        this.store.report.error = errorText(this.failure);
      }

      if (this.store.report.activeAgents.length) {
        this.store.report.logs.push(
          `${this.store.report.activeAgents.length} invocations have no terminal journal record; inspect invocations.jsonl`,
        );
        this.store.report.activeAgents = [];
      }

      this.store.report.status = finalStatus;
      this.store.report.durationMs = performance.now() - this.started;
      try {
        this.store.save();
      } finally {
        try {
          await closeControl?.();
        } finally {
          this.request.signal.removeEventListener("abort", abort);
        }
      }
    }

    return this.store.report;
  }

  skip(id: number) {
    const controller = this.controllers.get(id);
    if (!controller) {
      throw new Error(`Agent ${id} is not active or queued`);
    }

    controller.abort(new Error("Skipped by user"));
  }

  cancel(reason = "Cancelled by user") {
    this.stopped = true;
    this.controller.abort(new Error(reason));
  }

  async preflight(script: Script, path: string, depth = 0) {
    this.controller.signal.throwIfAborted();
    this.scripts.set(path, script);
    if (depth) {
      this.archiveChild(script, path);
    }

    const profileBackends = script.profiles.flatMap((name) => {
      const profile = this.request.config.profiles[name];
      if (!profile) {
        throw new Error(`Unknown profile: ${name}`);
      }

      return profile.backend ? [profile.backend] : [];
    });

    for (const name of new Set([
      this.request.config.backend,
      ...script.backends,
      ...profileBackends,
    ])) {
      const backend = backendName.parse(name);
      const detected = await this.detect(backend);
      this.controller.signal.throwIfAborted();
      if (!detected.available) {
        throw new Error(
          `Backend ${backend} is unavailable: ${detected.notes.join("; ")}\nRun workflow info to inspect capabilities.`,
        );
      }
    }

    for (const ref of script.children) {
      if (depth) {
        throw new Error(
          "Only one level of child workflow nesting is supported",
        );
      }

      const childPath = await this.resolveChild(ref, path);
      const child =
        this.scripts.get(childPath) ?? (await this.readChild(childPath));
      await this.preflight(child, childPath, depth + 1);
    }
  }

  private fail(error: unknown) {
    this.failure ??=
      error instanceof Error ? error : new Error(errorText(error));
    this.cancel(`Workflow infrastructure failed: ${errorText(error)}`);
  }

  private persist(action: () => void) {
    try {
      action();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  private event(event: RunEvent) {
    const active = this.store.report.activeAgents.find(
      (agent) => agent.id === event.id,
    );
    if (active) {
      if (event.type === "agent-started") {
        active.status = "running";
      }

      if (event.elapsedMs !== undefined) {
        active.elapsedMs = event.elapsedMs;
      }

      if (event.toolCalls !== undefined) {
        active.toolCalls = event.toolCalls;
      }

      if (event.text !== undefined) {
        active.activity = event.text;
      }

      // Activity is frequent; persist lifecycle changes immediately and throttle previews.
      if (
        event.type !== "activity" ||
        performance.now() - this.lastProgressSave > 250
      ) {
        this.persist(() => this.store.save());
        this.lastProgressSave = performance.now();
      }
    }

    this.request.onEvent({ ...event, runId: this.store.report.runId });
  }

  private options(value: Json): AgentOptions {
    const options = agentOptions.parse(value);
    if (options.agentType) {
      throw new Error(
        "agentType uses a harness-specific registry; define and select a workflow profile instead",
      );
    }

    const profile = options.profile
      ? this.request.config.profiles[options.profile]
      : undefined;
    if (options.profile && !profile) {
      throw new Error(`Unknown profile: ${options.profile}`);
    }

    const { systemAppend: _system, ...profileOptions } = profile ?? {};

    return agentOptions.parse({
      ...this.request.config.defaults,
      ...profileOptions,
      ...options,
    });
  }

  private validate(prompt: Json, value: Json) {
    this.controller.signal.throwIfAborted();
    if (this.stopped) {
      throw new Error("Workflow no longer accepts agents");
    }

    if (typeof prompt !== "string") {
      throw new Error("agent prompt must be a string");
    }

    if (this.count >= 1000) {
      throw new Error("Lifetime agent limit (1000) reached");
    }

    const options = this.options(value);
    if (options.schema) {
      compileSchema(options.schema);
    }
  }

  private detect(backend: BackendName): Promise<Detection> {
    let pending = this.detections.get(backend);
    if (!pending) {
      pending = this.request.drivers[backend].detect(
        this.request.cwd,
        this.controller.signal,
      );
      this.detections.set(backend, pending);
    }

    return pending;
  }

  private async resolveChild(ref: Json, parent: string): Promise<string> {
    // Once a reference resolves, keep its path stable for the rest of this run.
    const key = canonical({ parent, ref });
    const existing = this.childResolutions.get(key);
    if (existing) {
      return existing;
    }

    const remember = (path: string) => {
      this.childResolutions.set(key, path);

      return path;
    };
    if (typeof ref !== "string") {
      return remember(
        resolve(
          dirname(parent),
          z.object({ scriptPath: z.string() }).strict().parse(ref).scriptPath,
        ),
      );
    }

    if (ref.includes("/") || ref.endsWith(".js") || isAbsolute(ref)) {
      return remember(resolve(dirname(parent), ref));
    }

    for (const directory of [".workflow/workflows", ".claude/workflows"]) {
      const path = resolve(this.request.cwd, directory, `${ref}.js`);
      try {
        await access(path);

        return remember(path);
      } catch {
        /* try next registry */
      }
    }

    for (const directory of [".workflow/workflows", ".claude/workflows"]) {
      const path = resolve(this.request.cwd, directory, `${ref}.js`);
      if (this.savedChildren.has(path)) {
        return remember(path);
      }
    }

    throw new Error(`Unknown workflow ${ref}`);
  }

  private async readChild(path: string): Promise<Script> {
    try {
      return parseScript(await readScriptFile(path, this.controller.signal));
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw error;
      }

      const saved = this.savedChildren.get(path);
      if (!saved) {
        throw error;
      }

      try {
        const source = await readScriptFile(saved.file, this.controller.signal);
        if (
          createHash("sha256").update(source).digest("hex") !== saved.sha256
        ) {
          throw new Error(
            `Saved child source failed integrity check: ${saved.file}`,
          );
        }

        this.event({
          type: "warning",
          text: `Child ${path} is missing; using saved source ${saved.file}`,
        });

        return parseScript(source);
      } catch (archiveError) {
        this.fail(archiveError);
        throw archiveError;
      }
    }
  }

  private async execute(scope: Scope, args: Json): Promise<Json> {
    return executeScript(
      scope.script,
      args,
      {
        signal: this.controller.signal,
        holdExecution: () => this.replay.holdPreparation(),
        validateAgent: (prompt, options) => this.validate(prompt, options),
        agent: (prompt, options) => {
          const task = this.agent(
            z.string().parse(prompt),
            this.options(options),
            scope,
          ).catch((error) => {
            this.fail(error);
            throw error;
          });

          return this.trackTask(task);
        },
        phase: (title) => {
          scope.phase = title;
          this.event({ type: "phase", phase: title });
        },
        log: (message) => {
          this.store.report.logs.push(message);
          this.persist(() => this.store.save());
          this.event({ type: "log", text: message });
        },
        workflow: (ref, childArgs, override) =>
          this.trackTask(this.executeChild(scope, ref, childArgs, override)),
      },
      this.request.config.sandbox,
    );
  }

  private trackTask(task: Promise<Json>): Promise<Json> {
    this.pending.add(task);
    // Observe the derived cleanup promise; callers still receive the original
    // rejection, and agent infrastructure failures separately fail the root.
    void task.finally(() => this.pending.delete(task)).catch(() => {});

    return task;
  }

  private async executeChild(
    scope: Scope,
    ref: Json,
    args: Json,
    override: Json,
  ): Promise<Json> {
    // Hold replay delivery while resolving and preflighting the child. Release
    // before awaiting its execution so child agents can participate in replay.
    const release = this.replay.holdPreparation();
    try {
      if (scope.child) {
        throw new Error("workflow() cannot be called from a child workflow");
      }

      const options = z
        .object({ backend: backendName.optional() })
        .strict()
        .parse(override);
      this.controller.signal.throwIfAborted();
      const path = await this.resolveChild(ref, scope.path);
      const script = this.scripts.get(path) ?? (await this.readChild(path));
      if (!this.scripts.has(path)) {
        await this.preflight(script, path, 1);
      }

      this.controller.signal.throwIfAborted();
      const execution = this.execute(
        {
          script,
          path,
          backend: options.backend ?? scope.backend,
          child: true,
          phase: `▸ ${script.meta.name}`,
        },
        args,
      );

      release();

      return await execution;
    } finally {
      release();
    }
  }

  private async agent(
    prompt: string,
    options: AgentOptions,
    scope: Scope,
  ): Promise<Json> {
    const id = ++this.count;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const signal = AbortSignal.any([this.controller.signal, controller.signal]);
    const phase = options.phase ?? scope.phase;
    const backend = options.backend ?? scope.backend;
    const effective = { ...options, backend };

    // Replay identity includes the prompt and settings that can change its result.
    // Keep this context in sync when adding execution-affecting configuration.
    const key = canonical(
      jsonValue.parse({
        prompt,
        options: effective,
        context: {
          cwd: this.request.cwd,
          schemaStrategy: this.request.config.schemaStrategy,
          schemaRetries: this.request.config.schemaRetries,
          timeoutMs: this.request.config.transport.agentTimeoutMs,
          sharedPaths: this.request.config.sharedPaths,
        },
        systemAppend: this.profileSystemAppend(options),
      }),
    );

    this.store.startAgent({
      id,
      prompt,
      options: effective,
      key,
      phase,
      status: "queued",
      startedAt: new Date().toISOString(),
      elapsedMs: 0,
      toolCalls: 0,
    });
    this.event({
      type: "agent-queued",
      id,
      phase,
      label: options.label ?? `Agent ${id}`,
    });
    try {
      const outcome = await this.replay.call(
        key,
        async () =>
          toJournalValue(
            await this.liveAgent(id, prompt, effective, phase, signal),
          ),
        // Run cancellation leaves an unfinished invocation in the replay trace.
        // An intentional per-agent skip is still a completed, cacheable null.
        () => !this.controller.signal.aborted,
      );

      const original = agentRecord.parse(outcome.value);
      const record: AgentRecord = {
        ...original,
        id,
        cached: outcome.cached,
        key,
        phase,
        options: effective,
      };

      if (outcome.cached) {
        if (this.request.resume) {
          this.store.transcript(id, {
            type: "cache-hit",
            runId: this.request.resume,
            agentId: original.id,
          });
        }

        record.startedAt = new Date().toISOString();
        record.durationMs = 0;
      }

      this.store.agent(record);
      this.event({
        type: "agent-finished",
        id,
        phase,
        status: record.status,
        text: record.reason ?? (record.cached ? "cached" : undefined),
        elapsedMs: record.durationMs,
        toolCalls: record.toolCalls,
      });

      return record.result;
    } finally {
      this.controllers.delete(id);
    }
  }

  private profileSystemAppend(options: AgentOptions): string {
    return options.profile
      ? (this.request.config.profiles[options.profile]?.systemAppend ?? "")
      : "";
  }

  private liveAgent(
    id: number,
    prompt: string,
    options: AgentOptions & { backend: BackendName },
    phase: string,
    signal: AbortSignal,
  ): Promise<AgentRecord> {
    const execution = new AgentExecution(
      {
        id,
        prompt,
        options,
        phase,
        signal,
        runId: this.store.report.runId,
        cwd: this.request.cwd,
        settings: this.request.config,
        profileSystemAppend: this.profileSystemAppend(options),
        rootSignal: this.controller.signal,
      },
      {
        driver: this.request.drivers[options.backend],
        acquire: () => this.semaphore.acquire(signal),
        detect: () => this.detect(options.backend),
        emit: (event) => this.event(event),
        writeTranscript: (event) =>
          this.persist(() => this.store.transcript(id, event)),
        failRun: (error) => this.fail(error),
      },
    );

    return execution.run();
  }

  private archiveChild(script: Script, path: string) {
    this.persist(() => {
      if (this.archivedChildren.some((child) => child.path === path)) {
        return;
      }

      const file = `${this.archivedChildren.length}.js`;
      mkdirSync(join(this.store.directory, "children"), { recursive: true });
      writeFileSync(
        join(this.store.directory, "children", file),
        script.source,
        { mode: 0o600, flush: true },
      );
      this.archivedChildren.push({
        path,
        file,
        sha256: createHash("sha256").update(script.source).digest("hex"),
      });
      atomicJson(
        join(this.store.directory, "children", "manifest.json"),
        this.archivedChildren,
      );
    });
  }

  private restoreChildArchives() {
    if (this.request.resume) {
      const directory = join(
        runPath(this.request.root, this.request.resume),
        "children",
      );
      try {
        for (const child of childArchive.parse(
          JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")),
        )) {
          this.savedChildren.set(child.path, {
            file: join(directory, child.file),
            sha256: child.sha256,
          });
        }
      } catch (error) {
        if (!isErrno(error, "ENOENT")) {
          throw error;
        }
      }
    }
  }
}

export async function runWorkflow(request: RunRequest): Promise<Report> {
  const script = parseScript(request.source);

  return new WorkflowRun(request, script).run(script);
}

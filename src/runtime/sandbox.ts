import { readFileSync } from "node:fs";

import { getQuickJS } from "quickjs-emscripten";
import type {
  QuickJSHandle,
  QuickJSContext,
  QuickJSRuntime,
} from "quickjs-emscripten";

import { defaultSandbox } from "../config.js";
import type { SandboxSettings } from "../config.js";
import { errorText, jsonValue } from "../types.js";
import type { Json } from "../types.js";
import { itemsPerCall, stackBytes } from "./limits.js";
import type { Script } from "./script.js";

const guestSource = readFileSync(
  new URL("./guest.js", import.meta.url),
  "utf8",
);

function guestError(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    const name =
      "name" in value && typeof value.name === "string" ? value.name : "Error";
    const location =
      "stack" in value && typeof value.stack === "string"
        ? value.stack
            .split("\n")
            .find((line) => line.includes("workflow.js"))
            ?.trim()
        : undefined;

    return `${name}: ${value.message}${location ? ` (${location})` : ""}`;
  }

  return typeof value === "string" ? value : JSON.stringify(value);
}

export interface SandboxHost {
  validateAgent(prompt: Json, options: Json): void;
  agent(prompt: Json, options: Json): Promise<Json>;
  workflow(ref: Json, args: Json, options: Json): Promise<Json>;
  log(message: string): void;
  phase(title: string): void;
  warn?(message: string): void;
  signal: AbortSignal;
  holdExecution?: () => () => void;
}

// Each execution owns its VM, handles and job pump. Only JSON strings cross
// the bridge; no host objects, constructors, module loader or I/O enter the VM.
class GuestSession {
  private readonly vm: QuickJSContext;

  private readonly result: Promise<Json>;

  private resolveResult: (value: Json) => void = () => {};

  private rejectResult: (error: Error) => void = () => {};

  private closed = false;

  private settle: QuickJSHandle | undefined;

  private encodeResult: QuickJSHandle | undefined;

  private interruptChecks = 0;

  private interrupted = false;

  constructor(
    private runtime: QuickJSRuntime,
    private host: SandboxHost,
    limits: SandboxSettings,
    private releaseExecution: (() => void) | undefined,
  ) {
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(stackBytes);
    runtime.setInterruptHandler(() => {
      this.interrupted =
        host.signal.aborted || ++this.interruptChecks > limits.interruptChecks;

      return this.interrupted;
    });
    this.vm = runtime.newContext();
    this.result = new Promise<Json>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
  }

  async run(script: Script, args: Json): Promise<Json> {
    const onAbort = () =>
      this.fail(this.host.signal.reason ?? "Workflow cancelled");
    this.host.signal.addEventListener("abort", onAbort, { once: true });

    try {
      this.host.signal.throwIfAborted();
      this.installBridge();
      this.bootstrap(script, args);

      // User code is evaluated outside the bootstrap closure, so it cannot name
      // captured NativeDate or the host dispatch function.
      const execution = this.takeValue(
        this.vm.evalCode(`(async () => {\n${script.body}\n})()`, "workflow.js"),
      );
      void this.vm.resolvePromise(execution).then(
        (outcome) => this.deliverResult(outcome),
        (error) => this.fail(error),
      );
      execution.dispose();
      this.pump();

      return await this.result;
    } finally {
      this.closed = true;
      this.host.signal.removeEventListener("abort", onAbort);
      this.idle();
      this.settle?.dispose();
      this.encodeResult?.dispose();
      this.vm.dispose();
      this.runtime.dispose();
    }
  }

  private hold() {
    // Replay may deliver cached results only after guest microtasks drain.
    this.releaseExecution ??= this.host.holdExecution?.();
  }

  private idle() {
    this.releaseExecution?.();
    this.releaseExecution = undefined;
  }

  private fail(error: unknown) {
    this.rejectResult(new Error(errorText(error)));
  }

  private pump() {
    if (this.closed) {
      return;
    }

    // Finite job batches keep infinite promise chains interruptible by the host.
    const jobs = this.runtime.executePendingJobs(1024);
    if (jobs.error) {
      const detail: unknown = this.vm.dump(jobs.error);
      jobs.error.dispose();
      this.fail(guestError(detail));
    } else if (this.interrupted) {
      this.fail("Script execution interrupted: interrupt check limit exceeded");
    } else if (this.runtime.hasPendingJob()) {
      setImmediate(() => this.pump());

      return;
    }

    this.idle();
  }

  // Transfers a successful handle to the caller; failed handles are consumed here.
  private takeValue(
    outcome: ReturnType<QuickJSContext["evalCode"]>,
  ): QuickJSHandle {
    if (outcome.error) {
      const detail: unknown = this.vm.dump(outcome.error);
      outcome.error.dispose();
      throw new Error(guestError(detail));
    }

    return outcome.value;
  }

  private callback(
    name: string,
    body: (...values: Json[]) => Json | undefined,
  ) {
    const handle = this.vm.newFunction(name, (...handles) => {
      try {
        const values = handles.map((handle) =>
          jsonValue.parse(JSON.parse(this.vm.getString(handle))),
        );
        const output = body(...values);

        return output === undefined
          ? this.vm.undefined
          : this.vm.newString(JSON.stringify(output));
      } catch (error) {
        return { error: this.vm.newError(errorText(error)) };
      }
    });

    this.vm.setProp(this.vm.global, name, handle);
    handle.dispose();
  }

  private installBridge() {
    this.callback("__validate", (prompt = null, options = null) => {
      this.host.validateAgent(prompt, options);
    });

    this.callback("__notify", (kind, text) => {
      if (typeof text !== "string") {
        throw new Error("phase/log expect a string");
      }

      if (kind === "phase") {
        this.host.phase(text);
      } else if (kind === "warning") {
        this.host.warn?.(text);
      } else {
        this.host.log(text);
      }
    });

    this.callback("__dispatch", (id, kind, ...values) => {
      if (typeof id !== "number") {
        throw new Error("Invalid bridge request");
      }

      const task =
        kind === "agent"
          ? this.host.agent(values[0] ?? null, values[1] ?? {})
          : this.host.workflow(
              values[0] ?? null,
              values[1] ?? null,
              values[2] ?? {},
            );

      void task.then(
        (value) => this.deliver(id, true, value),
        (error) => this.deliver(id, false, errorText(error)),
      );
    });
  }

  private bootstrap(script: Script, args: Json) {
    for (const [name, value] of [
      ["__argsJson", args],
      ["__metaJson", script.meta],
      ["__itemsPerCallJson", itemsPerCall],
    ] as const) {
      const handle = this.vm.newString(JSON.stringify(value));
      this.vm.setProp(this.vm.global, name, handle);
      handle.dispose();
    }

    const exports = this.takeValue(this.vm.evalCode(guestSource, "guest.js"));
    this.settle = this.vm.getProp(exports, 0);
    this.encodeResult = this.vm.getProp(exports, 1);
    exports.dispose();
  }

  private deliver(id: number, success: boolean, value: Json) {
    if (this.closed || !this.settle) {
      return;
    }

    this.hold();
    const input = this.vm.newString(JSON.stringify([id, success, value]));
    const outcome = this.vm.callFunction(this.settle, this.vm.undefined, input);
    input.dispose();
    try {
      this.takeValue(outcome).dispose();
    } catch (error) {
      this.fail(error);
    }

    this.pump();
  }

  private deliverResult(
    outcome: Awaited<ReturnType<QuickJSContext["resolvePromise"]>>,
  ) {
    if (this.closed) {
      outcome.dispose();

      return;
    }

    try {
      if (outcome.error) {
        throw new Error(guestError(this.vm.dump(outcome.error)));
      }

      if (!this.encodeResult) {
        throw new Error("Result encoder unavailable");
      }

      const encoded = this.takeValue(
        this.vm.callFunction(
          this.encodeResult,
          this.vm.undefined,
          outcome.value,
        ),
      );

      try {
        this.resolveResult(
          jsonValue.parse(JSON.parse(this.vm.getString(encoded))),
        );
      } finally {
        encoded.dispose();
      }
    } catch (error) {
      this.fail(error);
    } finally {
      outcome.dispose();
    }
  }
}

export async function executeScript(
  script: Script,
  args: Json,
  host: SandboxHost,
  limits: SandboxSettings = defaultSandbox,
): Promise<Json> {
  // Acquire before loading QuickJS: replay must also wait through VM preparation.
  const release = host.holdExecution?.();
  let runtime: QuickJSRuntime | undefined;
  let session: GuestSession;
  try {
    const engine = await getQuickJS();
    runtime = engine.newRuntime();
    session = new GuestSession(runtime, host, limits, release);
  } catch (error) {
    runtime?.dispose();
    release?.();
    throw error;
  }

  return session.run(script, args);
}

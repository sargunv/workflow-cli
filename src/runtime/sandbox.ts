import { getQuickJS } from "quickjs-emscripten";
import type { QuickJSHandle } from "quickjs-emscripten";

import { errorText, jsonValue } from "../types.js";
import type { Json } from "../types.js";
import type { Script } from "./script.js";

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
  signal: AbortSignal;
  holdExecution?: () => () => void;
}
export interface SandboxLimits {
  memoryBytes?: number;
  instructions?: number;
}

// Only JSON strings cross the VM boundary. No host objects or function constructors
// become reachable from guest code. QuickJS has no host module loader or I/O bindings.
export async function executeScript(
  script: Script,
  args: Json,
  host: SandboxHost,
  limits: SandboxLimits = {},
): Promise<Json> {
  let releaseExecution = host.holdExecution?.();
  const hold = () => {
    releaseExecution ??= host.holdExecution?.();
  };
  const idle = () => {
    releaseExecution?.();
    releaseExecution = undefined;
  };
  const engine = await getQuickJS();
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes ?? 64 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  let instructions = 0;
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    interrupted =
      host.signal.aborted || ++instructions > (limits.instructions ?? 100_000);
    return interrupted;
  });
  const vm = runtime.newContext();
  let closed = false;
  let settle: QuickJSHandle | undefined;
  let encodeResult: QuickJSHandle | undefined;
  let resolveResult: (value: Json) => void = () => {};
  let rejectResult: (error: Error) => void = () => {};
  const result = new Promise<Json>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  function fail(error: unknown) {
    rejectResult(new Error(errorText(error)));
  }
  function pump() {
    if (closed) return;
    // A finite job batch keeps an infinite promise chain interruptible.
    const jobs = runtime.executePendingJobs(1024);
    if (jobs.error) {
      const detail: unknown = vm.dump(jobs.error);
      jobs.error.dispose();
      fail(guestError(detail));
    } else if (interrupted)
      fail("Script execution interrupted: instruction limit exceeded");
    else if (runtime.hasPendingJob()) {
      setImmediate(pump);
      return;
    }
    idle();
  }
  function callback(
    name: string,
    body: (...values: Json[]) => Json | undefined,
  ) {
    const handle = vm.newFunction(name, (...handles) => {
      try {
        const values = handles.map((handle) =>
          jsonValue.parse(JSON.parse(vm.getString(handle))),
        );
        const output = body(...values);
        return output === undefined
          ? vm.undefined
          : vm.newString(JSON.stringify(output));
      } catch (error) {
        return { error: vm.newError(errorText(error)) };
      }
    });
    vm.setProp(vm.global, name, handle);
    handle.dispose();
  }
  callback("__validate", (prompt = null, options = null) => {
    host.validateAgent(prompt, options);
  });
  callback("__notify", (kind, text) => {
    if (typeof text !== "string") throw new Error("phase/log expect a string");
    if (kind === "phase") host.phase(text);
    else host.log(text);
  });
  callback("__dispatch", (id, kind, ...values) => {
    if (typeof id !== "number") throw new Error("Invalid bridge request");
    const task =
      kind === "agent"
        ? host.agent(values[0] ?? null, values[1] ?? {})
        : host.workflow(values[0] ?? null, values[1] ?? null, values[2] ?? {});
    void task.then(
      (value) => deliver(id, true, value),
      (error) => deliver(id, false, errorText(error)),
    );
  });
  function deliver(id: number, success: boolean, value: Json) {
    if (closed || !settle) return;
    hold();
    const input = vm.newString(JSON.stringify([id, success, value]));
    const call = vm.callFunction(settle, vm.undefined, input);
    input.dispose();
    if (call.error) {
      const detail: unknown = vm.dump(call.error);
      call.error.dispose();
      fail(guestError(detail));
    } else call.value.dispose();
    pump();
  }
  const bootstrap = `(() => {
    const dispatch = __dispatch, validate = __validate, notify = __notify;
    delete globalThis.__dispatch; delete globalThis.__validate; delete globalThis.__notify;
    const stringify = JSON.stringify, parse = JSON.parse;
    const getPrototypeOf = Object.getPrototypeOf, objectPrototype = Object.prototype, isArray = Array.isArray;
    const encode = value => {
        return stringify(value, function(key, item) {
        if (typeof item === 'undefined' || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' || (typeof item === 'number' && !Number.isFinite(item))) throw new TypeError('Workflow values must be finite JSON values');
        if (item !== null && typeof item === 'object' && !isArray(item) && getPrototypeOf(item) !== objectPrototype && getPrototypeOf(item) !== null) throw new TypeError('Workflow values must be finite JSON values; convert collections to arrays or plain objects');
        return item;
      });
    };
    const NativeDate = Date;
    Object.defineProperty(NativeDate, 'now', { value() { throw new Error('Date.now() is nondeterministic'); }, writable: false, configurable: false });
    const SafeDate = new Proxy(NativeDate, {
      apply() { throw new Error('Date() is nondeterministic'); },
      construct(target, values, ctor) { if (!values.length) throw new Error('new Date() is nondeterministic'); return Reflect.construct(target, values, ctor); },
    });
    Object.defineProperty(NativeDate.prototype, 'constructor', { value: SafeDate });
    globalThis.Date = SafeDate;
    Object.defineProperty(Math, 'random', { value() { throw new Error('Math.random() is nondeterministic'); }, writable: false, configurable: false });
    const pending = new Map(); let sequence = 0;
    const invoke = (kind, ...values) => {
      const encoded = values.map(encode); const id = ++sequence;
      return new Promise((resolve, reject) => { pending.set(id, {resolve, reject}); try { dispatch(encode(id), encode(kind), ...encoded); } catch (error) { pending.delete(id); reject(error); } });
    };
    const install = (name, value) => Object.defineProperty(globalThis, name, { value, writable: false, configurable: false });
    install('agent', (prompt, options = {}) => { validate(encode(prompt), encode(options)); return invoke('agent', prompt, options); });
    install('workflow', (ref, args = null, options = {}) => invoke('workflow', ref, args, options));
    install('phase', title => notify(encode('phase'), encode(title)));
    install('log', text => notify(encode('log'), encode(text)));
    install('parallel', async thunks => {
      if (!Array.isArray(thunks) || thunks.length > 4096) throw new Error('parallel requires an array of at most 4096 functions');
      return Promise.all(thunks.map(async thunk => { try { return await thunk(); } catch { return null; } }));
    });
    install('pipeline', async (items, ...stages) => {
      if (!Array.isArray(items) || items.length > 4096) throw new Error('pipeline requires an array of at most 4096 items');
      return Promise.all(items.map(async (item, index) => { let result = item; for (const stage of stages) { try { result = await stage(result, item, index); } catch { return null; } } return result; }));
    });
    install('args', parse(${JSON.stringify(JSON.stringify(args))}));
    install('meta', parse(${JSON.stringify(JSON.stringify(script.meta))}));
    install('budget', Object.freeze({ total: null, spent: () => 0, remaining: () => Infinity }));
    return [encoded => { const [id, success, value] = parse(encoded); const deferred = pending.get(id); if (!deferred) throw new Error('Unknown bridge response'); pending.delete(id); if (success) deferred.resolve(value); else deferred.reject(new Error(value)); }, value => encode(value === undefined ? null : value)];
  })()`;
  const onAbort = () => fail(host.signal.reason ?? "Workflow cancelled");
  host.signal.addEventListener("abort", onAbort, { once: true });
  try {
    host.signal.throwIfAborted();
    const evaluated = vm.evalCode(bootstrap, "workflow.js");
    if (evaluated.error) {
      const detail: unknown = vm.dump(evaluated.error);
      evaluated.error.dispose();
      throw new Error(guestError(detail));
    }
    settle = vm.getProp(evaluated.value, 0);
    encodeResult = vm.getProp(evaluated.value, 1);
    evaluated.value.dispose();
    // Evaluate user code separately, outside the bootstrap closure. Otherwise it
    // could name captured NativeDate or the host dispatch function directly.
    const execution = vm.evalCode(
      `(async () => {\n${script.body}\n})()`,
      "workflow.js",
    );
    if (execution.error) {
      const detail: unknown = vm.dump(execution.error);
      execution.error.dispose();
      throw new Error(guestError(detail));
    }
    void vm.resolvePromise(execution.value).then((outcome) => {
      if (closed) {
        outcome.dispose();
        return;
      }
      try {
        if (outcome.error) fail(guestError(vm.dump(outcome.error)));
        else {
          if (!encodeResult) throw new Error("Result encoder unavailable");
          const encoded = vm.callFunction(
            encodeResult,
            vm.undefined,
            outcome.value,
          );
          try {
            if (encoded.error) fail(guestError(vm.dump(encoded.error)));
            else
              resolveResult(
                jsonValue.parse(JSON.parse(vm.getString(encoded.value))),
              );
          } finally {
            encoded.dispose();
          }
        }
      } catch (error) {
        fail(error);
      } finally {
        outcome.dispose();
      }
    }, fail);
    execution.value.dispose();
    pump();
    return await result;
  } finally {
    closed = true;
    host.signal.removeEventListener("abort", onAbort);
    idle();
    settle?.dispose();
    encodeResult?.dispose();
    vm.dispose();
    runtime.dispose();
  }
}

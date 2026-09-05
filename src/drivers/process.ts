import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { errorText, ProcessOwnershipError } from "../types.js";

const supervisorPath = fileURLToPath(
  new URL("./supervisor.cjs", import.meta.url),
);

const backendExitSchema = z.object({
  type: z.literal("backend-exit"),
  code: z.number().int().nullable(),
  signal: z.string().nullable().optional(),
  error: z.string().optional(),
});

export async function findBinary(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) {
      continue;
    }
    const path = join(directory, name);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* try next PATH entry */
    }
  }
  return undefined;
}

export interface ProcessOptions {
  cwd: string;
  signal: AbortSignal;
  timeoutMs?: number;
  onLine?: (line: string, channel: "stdout" | "stderr") => void;
  env?: NodeJS.ProcessEnv;
}

export interface ProcessExit {
  code: number;
  stderr: string;
  error?: string;
  cleanupUncertain?: boolean;
}

export class ManagedProcess {
  readonly child;
  readonly exited: Promise<ProcessExit>;
  private stopped = false;
  private abortReason: string | undefined;
  private killTimer: NodeJS.Timeout | undefined;
  private forcedGroupKill = false;
  private deadline: NodeJS.Timeout | undefined;

  constructor(binary: string, argv: string[], options: ProcessOptions) {
    options.signal.throwIfAborted();
    if (process.platform === "win32") {
      throw new Error(
        "Windows process-tree ownership is not implemented; use WSL",
      );
    }
    this.child = spawn(process.execPath, [supervisorPath, binary, ...argv], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      detached: true,
      env: { ...process.env, ...options.env },
    });
    let stderr = "";
    this.resetTimeout(options.timeoutMs ?? 900_000);
    const abort = () =>
      this.stop(errorText(options.signal.reason ?? "Cancelled"));
    options.signal.addEventListener("abort", abort, { once: true });
    // Stream full records to transcripts, bounded tails to diagnostics. Never buffer
    // a vendor transcript in the caller's context.
    for (const channel of ["stdout", "stderr"] as const) {
      const decoder = new StringDecoder("utf8");
      let pending = "";
      const consume = (chunk: string) => {
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (channel === "stderr") {
            stderr = (stderr + line + "\n").slice(-8192);
          }
          try {
            options.onLine?.(line, channel);
          } catch (error) {
            this.stop(`Stream handler failed: ${errorText(error)}`);
          }
        }
        if (pending.length > 16 * 1024 * 1024) {
          this.stop("Backend emitted a record larger than 16 MiB");
        }
      };
      this.child[channel]?.on("data", (chunk: Buffer) =>
        consume(decoder.write(chunk)),
      );
      this.child[channel]?.on("end", () => {
        consume(decoder.end() + (pending ? "\n" : ""));
      });
    }
    this.child.stdin?.on("error", () => {
      /* EPIPE is reported by the process exit. */
    });
    this.exited = new Promise((resolve) => {
      let spawnError: string | undefined;
      let backendExit: { code: number; error?: string } | undefined;
      let drainTimer: NodeJS.Timeout | undefined;
      let settled = false;
      this.child.on("message", (message: unknown) => {
        const parsed = backendExitSchema.safeParse(message);
        if (!parsed.success) {
          return;
        }
        const value = parsed.data;
        let error = value.error;
        if (error === undefined && typeof value.signal === "string") {
          error = `Backend exited on ${value.signal}`;
        }
        backendExit = {
          code: typeof value.code === "number" ? value.code : 1,
          error,
        };
      });
      this.child.once("error", (error) => {
        spawnError = error.message;
      });
      const finish = (
        _code: number | null,
        signal: NodeJS.Signals | null,
        drainError?: string,
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(this.deadline);
        clearTimeout(this.killTimer);
        clearTimeout(drainTimer);
        options.signal.removeEventListener("abort", abort);
        this.stopped = true;
        resolve({
          code: drainError ? 1 : (backendExit?.code ?? 1),
          // A drain timeout may mean an escaped descendant still owns pipes.
          // Without a backend report, failed spawn, or our forced group kill,
          // an unexpected supervisor exit cannot prove its descendants exited.
          cleanupUncertain:
            !!drainError ||
            (!backendExit && !spawnError && !this.forcedGroupKill),
          stderr,
          error:
            drainError ??
            this.abortReason ??
            spawnError ??
            backendExit?.error ??
            (backendExit
              ? undefined
              : `Backend supervisor exited unexpectedly (${signal ?? _code})`),
        });
      };
      this.child.once("close", finish);
      this.child.once("exit", (code, signal) => {
        // A crashed supervisor or a descendant escaping the owned group can
        // retain inherited pipes. Never wait forever for Node's close event.
        drainTimer = setTimeout(() => {
          this.child.stdin?.destroy();
          this.child.stdout?.destroy();
          this.child.stderr?.destroy();
          finish(
            code,
            signal,
            "Backend output remained open after supervisor exit; closed pipes after 1000ms. A descendant may have left the owned process group.",
          );
        }, 1000);
      });
    });
  }

  write(value: string) {
    if (!this.stopped) {
      this.child.stdin?.write(value);
    }
  }

  resetTimeout(timeoutMs: number) {
    if (this.stopped) {
      throw new Error("Backend process already stopped");
    }
    clearTimeout(this.deadline);
    this.deadline = setTimeout(
      () => this.stop(`Backend timed out after ${timeoutMs}ms`),
      timeoutMs,
    );
  }

  end(value = "") {
    this.child.stdin?.end(value);
  }

  private kill(signal: NodeJS.Signals) {
    // Signal only while our direct child still anchors this process group.
    if (
      this.child.pid &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      try {
        process.kill(-this.child.pid, signal);
        if (signal === "SIGKILL") {
          this.forcedGroupKill = true;
        }
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        ) {
          this.child.kill(signal);
        }
      }
    }
  }

  stop(reason = "Backend stopped") {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.abortReason = reason;
    this.kill("SIGTERM");
    this.killTimer = setTimeout(() => this.kill("SIGKILL"), 1000);
  }
}

export async function capture(
  binary: string,
  argv: string[],
  cwd: string,
  timeoutMs = 10_000,
  signal = new AbortController().signal,
): Promise<string> {
  let output = "";
  const process = new ManagedProcess(binary, argv, {
    cwd,
    signal,
    timeoutMs,
    onLine(line, channel) {
      if (channel === "stdout") {
        output += line + "\n";
        if (output.length > 4 * 1024 * 1024) {
          throw new Error("Discovery output exceeded 4 MiB");
        }
      }
    },
  });
  process.end();
  const exit = await process.exited;
  if (exit.cleanupUncertain) {
    throw new ProcessOwnershipError(exit.error);
  }
  if (exit.code !== 0 || exit.error) {
    throw new Error(exit.error ?? exit.stderr ?? `Exited ${exit.code}`);
  }
  return output.trim();
}

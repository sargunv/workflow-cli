import { fork } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { configSchema } from "./config.js";
import { jsonValue } from "./types.js";

export const launchSchema = z
  .object({
    source: z.string(),
    scriptPath: z.string(),
    args: jsonValue,
    cwd: z.string(),
    root: z.string(),
    config: configSchema,
    resume: z.string().optional(),
  })
  .strict();
export type Launch = z.infer<typeof launchSchema>;
const replySchema = z
  .object({
    type: z.enum(["starting", "ready", "failed"]),
    runId: z.string(),
    directory: z.string(),
    scriptPath: z.string(),
    error: z.string().optional(),
  })
  .strict();
export type LaunchReply = z.infer<typeof replySchema>;
export interface LaunchResult extends LaunchReply {
  warning?: string;
  logsDirectory?: string;
}
export async function launchBackground(
  cliPath: string,
  launch: Launch,
): Promise<LaunchResult> {
  await mkdir(launch.root, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(launch.root, ".launch-"));
  await writeFile(join(temporary, "launch.json"), JSON.stringify(launch), {
    mode: 0o600,
  });
  const stdout = openSync(join(temporary, "stdout.log"), "wx", 0o600),
    stderr = openSync(join(temporary, "stderr.log"), "wx", 0o600);
  const worker = fork(cliPath, ["__worker", temporary], {
    cwd: launch.cwd,
    detached: true,
    stdio: ["ignore", stdout, stderr, "ipc"],
  });
  closeSync(stdout);
  closeSync(stderr);
  return new Promise((resolve, reject) => {
    let done = false,
      cancelling: Error | undefined,
      location = temporary;
    let escalation: NodeJS.Timeout | undefined,
      kill: NodeJS.Timeout | undefined;
    const timer = setTimeout(
      () =>
        cancel(
          new Error(
            `Background launch timed out after ${launch.config.transport.launchTimeoutMs}ms`,
          ),
        ),
      launch.config.transport.launchTimeoutMs,
    );
    const clear = () => {
      clearTimeout(timer);
      clearTimeout(escalation);
      clearTimeout(kill);
    };
    const rejectStopped = (error: Error) => {
      if (done) return;
      done = true;
      clear();
      reject(
        new Error(
          `${error.message}. Startup logs: ${temporary}. Run details: ${location}`,
          { cause: error },
        ),
      );
    };
    const cancel = (error: Error) => {
      if (done || cancelling) return;
      cancelling = error;
      clearTimeout(timer);
      if (worker.connected) worker.send({ type: "cancel-startup" }, () => {});
      escalation = setTimeout(() => worker.kill("SIGTERM"), 3000);
      kill = setTimeout(() => worker.kill("SIGKILL"), 5000);
    };
    worker.once("error", (error) => {
      if (worker.pid) cancel(error);
      else rejectStopped(error);
    });
    worker.once("exit", (code, signal) =>
      rejectStopped(
        cancelling ??
          new Error(
            `Background launcher exited before acknowledging startup (${signal ?? code})`,
          ),
      ),
    );
    worker.on("message", (message: unknown) => {
      if (done) return;
      const parsed = replySchema.safeParse(message);
      if (!parsed.success) {
        cancel(new Error("Invalid background launch acknowledgement"));
        return;
      }
      const reply = parsed.data;
      location = reply.directory;
      if (reply.type === "starting" || cancelling) return;
      done = true;
      clear();
      void (async () => {
        const result: LaunchResult = { ...reply };
        try {
          // Open descriptors survive rename; ongoing output follows the file.
          await rename(
            join(temporary, "stdout.log"),
            join(reply.directory, "stdout.log"),
          );
          await rename(
            join(temporary, "stderr.log"),
            join(reply.directory, "stderr.log"),
          );
          await rm(temporary, { recursive: true });
        } catch {
          // A diagnostics move cannot turn a successfully started run into an
          // unacknowledged orphan. Return its identity and the retained log path.
          result.warning =
            "Some startup logs could not be moved into the run directory";
          result.logsDirectory = temporary;
        }
        if (worker.connected) worker.disconnect();
        worker.unref();
        if (reply.type === "failed")
          reject(
            new Error(
              `${reply.error ?? "Launch failed"}\nRun: ${reply.runId}\nDetails: ${reply.directory}\nStartup logs: ${result.logsDirectory ?? reply.directory}`,
            ),
          );
        else resolve(result);
      })().catch(reject);
    });
  });
}
export async function readLaunch(directory: string): Promise<Launch> {
  return launchSchema.parse(
    JSON.parse(await readFile(join(directory, "launch.json"), "utf8")),
  );
}
export function notifyLauncher(reply: LaunchReply): Promise<void> {
  if (!process.send || !process.connected)
    return Promise.reject(
      new Error("Background worker requires its launcher IPC connection"),
    );
  return new Promise((resolve, reject) =>
    process.send?.(reply, (error) => (error ? reject(error) : resolve())),
  );
}

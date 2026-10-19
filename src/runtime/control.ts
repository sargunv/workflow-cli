import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";

import { z } from "zod";

import { errorText, isErrno } from "../types.ts";
import { atomicJson, readReport, runPath } from "./store.ts";
import type { Report } from "./store.ts";

const maxMessageLength = 4096;

const endpointSchema = z
  .object({
    port: z.number().int().min(1).max(65535),
    token: z.string().length(64),
    runId: z.string(),
  })
  .strict();

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ping") }),
  z.object({ action: z.literal("stop") }),
  z.object({ action: z.literal("skip"), id: z.number().int().positive() }),
]);

type ControlAction = z.infer<typeof actionSchema>;

const responseSchema = z.object({
  ok: z.boolean(),
  runId: z.string(),
  error: z.string().optional(),
});

// Each side sends one newline-terminated JSON message, capped so a peer cannot
// make the other buffer without bound.
function readMessage(
  socket: Socket,
  onMessage: (line: string) => void,
  onOverflow: () => void,
) {
  let input = "";
  let done = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    if (done) {
      return;
    }

    input += chunk;
    if (input.length > maxMessageLength) {
      done = true;
      onOverflow();

      return;
    }

    const end = input.indexOf("\n");
    if (end !== -1) {
      done = true;
      onMessage(input.slice(0, end));
    }
  });
}

interface ControlTarget {
  runId: string;
  cancel: () => void;
  skip: (id: number) => void;
}

export async function startControl(
  directory: string,
  target: ControlTarget,
): Promise<() => Promise<void>> {
  const token = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(2000, () => socket.destroy());
    readMessage(
      socket,
      (line) => {
        let action: ControlAction;
        try {
          const request = z
            .object({
              token: z.string().length(64),
              runId: z.literal(target.runId),
              command: actionSchema,
            })
            .strict()
            .parse(JSON.parse(line));

          if (
            !timingSafeEqual(Buffer.from(request.token), Buffer.from(token))
          ) {
            throw new Error("Invalid control credentials");
          }

          action = request.command;
          if (action.action === "skip") {
            target.skip(action.id);
          }
        } catch (error) {
          socket.end(
            JSON.stringify({
              ok: false,
              runId: target.runId,
              error: errorText(error),
            }) + "\n",
          );

          return;
        }

        // Acknowledge before cancellation stops new agents and closes this server.
        socket.end(
          JSON.stringify({ ok: true, runId: target.runId }) + "\n",
          () => {
            if (action.action === "stop") {
              target.cancel();
            }
          },
        );
      },
      () => socket.destroy(),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Run control did not bind a local port");
  }

  try {
    atomicJson(join(directory, "control.json"), {
      port: address.port,
      token,
      runId: target.runId,
    });
  } catch (error) {
    server.close();
    throw error;
  }

  return () =>
    new Promise<void>((resolve, reject) => {
      for (const socket of sockets) {
        socket.destroy();
      }

      server.close((error) => (error ? reject(error) : resolve()));
    });
}

export async function controlRun(
  root: string,
  id: string,
  command: ControlAction,
): Promise<void> {
  const endpoint = endpointSchema.parse(
    JSON.parse(await readFile(join(runPath(root, id), "control.json"), "utf8")),
  );
  if (endpoint.runId !== id) {
    throw new Error("Control endpoint belongs to another run");
  }

  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: endpoint.port });
    let complete = false;
    const finish = (error?: unknown) => {
      if (complete) {
        return;
      }

      complete = true;
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    socket.setTimeout(2000, () =>
      finish(
        new Error(
          "Run control did not respond; the run may still be busy. Try again.",
        ),
      ),
    );
    socket.on("error", finish);
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({ token: endpoint.token, runId: id, command }) + "\n",
      ),
    );
    readMessage(
      socket,
      (line) => {
        try {
          const response = responseSchema.parse(JSON.parse(line));
          if (response.runId !== id || !response.ok) {
            throw new Error(response.error ?? "Run control identity mismatch");
          }

          finish();
        } catch (error) {
          finish(error);
        }
      },
      () => finish(new Error("Invalid run control response")),
    );
    socket.on("end", () => {
      if (!complete) {
        finish(
          new Error("Run control closed without acknowledging the command"),
        );
      }
    });
  });
}

export async function inspectReport(root: string, id: string): Promise<Report> {
  const report = readReport(root, id);
  if (report.status !== "running") {
    return report;
  }

  try {
    await controlRun(root, id, { action: "ping" });

    return readReport(root, id);
  } catch (error) {
    // Observation timeout is not evidence that a process has stopped.
    if (isErrno(error, "ECONNREFUSED")) {
      const current = readReport(root, id);
      if (current.status !== "running") {
        return current;
      }

      return {
        ...current,
        status: "interrupted",
        error:
          "Run control is no longer listening. Inspect journals and retained worktrees before resuming.",
      };
    }

    try {
      process.kill(report.pid, 0);
    } catch (processError) {
      if (isErrno(processError, "ESRCH")) {
        return {
          ...report,
          status: "interrupted",
          error:
            "The run process exited before saving a terminal report. Inspect journals and retained worktrees before resuming.",
        };
      }
    }

    return { ...report, observation: errorText(error) };
  }
}

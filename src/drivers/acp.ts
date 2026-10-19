import { defaultTransport } from "../config.js";
import type { TransportSettings } from "../config.js";
import {
  effort as effortSchema,
  errorText,
  ProcessOwnershipError,
} from "../types.js";
import type {
  Detection,
  Driver,
  DriverEvent,
  DriverRequest,
  DriverResult,
  ModelInfo,
} from "../types.js";
import { version } from "../version.js";
import { object, array, decode, string, AcpEventParser } from "./events.js";
import { capture, findBinary, ManagedProcess } from "./process.js";

type AcpBackend = "opencode" | "kimi" | "qwen";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

// Native ACP transports observed against OpenCode 1.18.28, Kimi 0.41.0 and
// Qwen 0.23.0. One process per leaf bounds a crash/cancel to one agent.
export class AcpConnection {
  readonly process: ManagedProcess;

  onUpdate: (params: Record<string, unknown>) => void = () => {};

  private sequence = 0;

  private pending = new Map<number, Pending>();

  private ended = false;

  constructor(
    binary: string,
    argv: string[],
    cwd: string,
    signal: AbortSignal,
    private emit: (event: DriverEvent) => void,
    private transport: TransportSettings = defaultTransport,
  ) {
    this.process = new ManagedProcess(binary, argv, {
      cwd,
      signal,
      timeoutMs: transport.agentTimeoutMs,
      onLine: (line, channel) => this.line(line, channel),
    });
    void this.process.exited.then((exit) => {
      this.ended = true;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(
          exit.cleanupUncertain
            ? new ProcessOwnershipError(exit.error)
            : new Error(
                exit.error ?? (exit.stderr.trim() || `ACP exited ${exit.code}`),
              ),
        );
      }

      this.pending.clear();
    });
  }

  request(
    method: string,
    params: unknown,
    timeoutMs: number | null = this.transport.discoveryTimeoutMs,
  ): Promise<unknown> {
    if (this.ended) {
      return Promise.reject(new Error("ACP process already exited"));
    }

    const id = ++this.sequence;

    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`ACP ${method} timed out`));
              this.process.stop("ACP request timeout");
            }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async start(cwd: string) {
    const init = object(
      await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "workflow", version },
      }),
    );

    if (init.protocolVersion !== 1) {
      throw new Error("ACP server does not support protocol version 1");
    }

    const session = object(
      await this.request("session/new", { cwd, mcpServers: [] }),
    );
    if (typeof session.sessionId !== "string") {
      throw new Error(
        "ACP session/new did not return a session ID; authenticate the backend directly",
      );
    }

    return { init, session };
  }

  async close() {
    this.process.stop("ACP session complete");
    const exit = await this.process.exited;
    if (exit.cleanupUncertain) {
      throw new ProcessOwnershipError(exit.error);
    }
  }

  private line(line: string, channel: "stdout" | "stderr") {
    this.emit({ type: "raw", raw: { channel, line } });
    if (channel !== "stdout") {
      return;
    }

    const message = decode(line);
    if (!message) {
      return;
    }

    if (typeof message.method === "string") {
      this.handleServerMessage(message);
    } else {
      this.completeRequest(message);
    }
  }

  private handleServerMessage(message: Record<string, unknown>) {
    const params = object(message.params);
    if (message.method === "session/update") {
      this.onUpdate(params);

      return;
    }

    if (message.id === undefined) {
      return;
    }

    if (message.method !== "session/request_permission") {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Client method not supported" },
      });

      return;
    }

    // Prefer consent for this call over permission that outlives it.
    const choices = array(params.options).map(object);
    const option =
      choices.find((choice) => choice.kind === "allow_once") ??
      choices.find((choice) => choice.kind === "allow_always");
    this.send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        outcome: option
          ? { outcome: "selected", optionId: option.optionId }
          : { outcome: "cancelled" },
      },
    });
  }

  private completeRequest(message: Record<string, unknown>) {
    if (typeof message.id !== "number") {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(
        new Error(
          string(object(message.error).message) || "ACP request failed",
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private send(message: unknown) {
    this.process.write(JSON.stringify(message) + "\n");
  }
}

function modelOptions(session: Record<string, unknown>): ModelInfo[] {
  const config = array(session.configOptions)
    .map(object)
    .find((option) => option.category === "model" || option.id === "model");
  const configEntries = array(config?.options);
  const entries = configEntries.length
    ? configEntries
    : array(object(session.models).availableModels);
  const current = string(
    config?.currentValue ?? object(session.models).currentModelId,
  );
  const models = entries
    .map((entry) => {
      const model = object(entry);
      const id = string(model.value ?? model.modelId ?? model.id);

      return {
        id,
        default: id === current,
        efforts: [],
      };
    })
    .filter((model) => model.id);

  if (current && !models.some((model) => model.id === current)) {
    models.push({ id: current, default: true, efforts: [] });
  }

  return models;
}

export class AcpDriver implements Driver {
  private detection?: Detection;

  constructor(
    readonly name: AcpBackend,
    private transport: TransportSettings = defaultTransport,
  ) {}

  async detect(
    cwd: string,
    signal = new AbortController().signal,
  ): Promise<Detection> {
    signal.throwIfAborted();
    if (this.detection) {
      return this.detection;
    }

    const binary = await findBinary(this.name);
    const detection: Detection = {
      name: this.name,
      available: !!binary,
      binary,
      notes: [],
      transport: "acp",
      models: [],
      structured: "prompted",
      correction: "session",
      worktree: true,
      toolPolicies: [],
      minimal: false,
      usage: this.name === "opencode",
    };

    if (binary) {
      let connection: AcpConnection | undefined;
      try {
        detection.version = await capture(
          binary,
          ["--version"],
          cwd,
          this.transport.discoveryTimeoutMs,
          signal,
        );
        connection = new AcpConnection(
          binary,
          this.argv(),
          cwd,
          signal,
          () => {},
          this.transport,
        );
        const { session } = await connection.start(cwd);
        detection.models = modelOptions(session);
        const effort = array(session.configOptions)
          .map(object)
          .find(
            (option) =>
              option.category === "thought_level" || option.id === "thinking",
          );

        if (effort) {
          for (const model of detection.models) {
            if (model.default) {
              model.efforts = array(effort.options)
                .map((option) => string(object(option).value))
                .filter((value) => effortSchema.safeParse(value).success);
            }
          }
        }
      } catch (error) {
        detection.available = false;
        detection.notes.push(
          `ACP initialization failed: ${errorText(error)}. Authenticate ${this.name} directly.`,
        );
      } finally {
        await connection?.close();
      }
    } else {
      detection.notes.push(`Install and authenticate ${this.name}`);
    }

    detection.notes.push(
      "Native ACP: client permission requests auto-approved; no enforceable read-only policy",
      "Backend retains its own sessions",
    );
    signal.throwIfAborted();
    this.detection = detection;

    return detection;
  }

  async run(request: DriverRequest) {
    if (request.toolPolicy) {
      throw new Error(`${this.name} ACP cannot enforce tool policies`);
    }

    if (request.minimal) {
      throw new Error(`${this.name} ACP cannot suppress instruction loading`);
    }

    const detection = await this.detect(request.cwd, request.signal);
    if (!detection.available || !detection.binary) {
      throw new Error(
        `${this.name} unavailable: ${detection.notes.join("; ")}`,
      );
    }

    const connection = new AcpConnection(
      detection.binary,
      this.argv(),
      request.cwd,
      request.signal,
      request.onEvent,
      this.transport,
    );

    const parser = new AcpEventParser(request.onEvent);
    let retained = false;
    try {
      const { session } = await connection.start(request.cwd);
      const sessionId = session.sessionId;
      connection.onUpdate = (params) => {
        if (params.sessionId !== sessionId) {
          return;
        }

        parser.update(object(params.update));
      };
      await this.configureSession(connection, session, request);
      const prompt = async (textPrompt: string): Promise<DriverResult> => {
        connection.process.resetTimeout(this.transport.agentTimeoutMs);
        parser.reset();
        const result = object(
          await connection.request(
            "session/prompt",
            {
              sessionId,
              prompt: [
                {
                  type: "text",
                  text: textPrompt,
                },
              ],
            },
            this.transport.agentTimeoutMs,
          ),
        );

        return parser.finish(result);
      };

      const result = await prompt(
        `${request.systemAppend}\n\nTask:\n${request.prompt}`,
      );
      if (request.keepSession) {
        retained = true;

        return {
          ...result,
          session: { prompt, close: () => connection.close() },
        };
      }

      return result;
    } finally {
      if (!retained) {
        await connection.close();
      }
    }
  }

  private argv() {
    return this.name === "qwen" ? ["--acp"] : ["acp"];
  }

  /** Each setter can replace the option catalog; keep model → mode → effort order. */
  private async configureSession(
    connection: AcpConnection,
    session: Record<string, unknown>,
    request: DriverRequest,
  ) {
    const sessionId = session.sessionId;
    let config = array(session.configOptions).map(object);
    const configure = async (configId: string, value: string) => {
      const response = object(
        await connection.request("session/set_config_option", {
          sessionId,
          configId,
          value,
        }),
      );

      const updated = array(response.configOptions).map(object);
      if (updated.length) {
        config = updated;
      }

      const applied = updated.find((option) => option.id === configId);
      if (
        applied?.currentValue !== undefined &&
        applied.currentValue !== value
      ) {
        throw new Error(
          `${this.name} did not apply ${configId}=${value}; reported ${string(applied.currentValue)}`,
        );
      }

      if (!applied) {
        request.onEvent({
          type: "warning",
          text: `${this.name} acknowledged ${configId}=${value} without reporting its active value`,
        });
      }
    };

    if (request.model) {
      const option = config.find(
        (option) => option.category === "model" || option.id === "model",
      );
      if (option) {
        await configure(string(option.id), request.model);
      } else {
        const response = object(
          await connection.request("session/set_model", {
            sessionId,
            modelId: request.model,
          }),
        );

        const current =
          response.currentModelId ?? object(response.models).currentModelId;
        if (current !== undefined && current !== request.model) {
          throw new Error(
            `${this.name} did not apply requested model ${request.model}; reported ${string(current)}`,
          );
        }

        if (current === undefined) {
          request.onEvent({
            type: "warning",
            text: `${this.name} acknowledged model ${request.model} without reporting its active value`,
          });
        }
      }
    }

    const mode = config.find(
      (option) => option.category === "mode" || option.id === "mode",
    );
    if (
      mode &&
      array(mode.options).some((option) => object(option).value === "yolo")
    ) {
      await configure(string(mode.id), "yolo");
    }

    if (request.effort) {
      const option = config.find(
        (option) =>
          option.category === "thought_level" || option.id === "thinking",
      );
      if (
        option &&
        array(option.options).some(
          (value) => object(value).value === request.effort,
        )
      ) {
        await configure(string(option.id), request.effort);
      } else {
        request.onEvent({
          type: "warning",
          text: `${this.name} does not expose effort ${request.effort}; effort was not applied`,
        });
      }
    }
  }
}

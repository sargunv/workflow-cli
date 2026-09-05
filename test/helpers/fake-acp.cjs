#!/usr/bin/env node
// Synthetic ACP server for offline transport tests. No vendor or network access.
const fs = require("node:fs");
const readline = require("node:readline");
if (process.argv.includes("--version")) {
  console.log("fixture-acp 1.0");
  process.exit(0);
}
const send = (value) =>
  console.log(JSON.stringify({ jsonrpc: "2.0", ...value }));
const sessionId = "fixture-session";
const configurations = process.env.WORKFLOW_FIXTURE_ACP_CONFIGS
  ? JSON.parse(
      fs.readFileSync(process.env.WORKFLOW_FIXTURE_ACP_CONFIGS, "utf8"),
    )
  : undefined;
let config = configurations?.[0];
let turn = 0;
let pending;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (process.env.WORKFLOW_FIXTURE_ACP_LOG)
    fs.appendFileSync(process.env.WORKFLOW_FIXTURE_ACP_LOG, line + "\n");
  const reply = (result) => send({ id: message.id, result });
  switch (message.method) {
    case "initialize":
      reply({ protocolVersion: 1 });
      break;
    case "session/new":
      reply({
        sessionId,
        ...(config
          ? {
              models: JSON.parse(
                fs.readFileSync(
                  process.env.WORKFLOW_FIXTURE_ACP_CONFIGS.replace(
                    "qwen-model-config.json",
                    "qwen-session-config.json",
                  ),
                  "utf8",
                ),
              ).models,
            }
          : {}),
        configOptions: config ?? [
          {
            id: "model",
            category: "model",
            currentValue: "fixture-small",
            options: [{ value: "fixture-small" }, { value: "fixture-large" }],
          },
          {
            id: "thinking",
            category: "thought_level",
            currentValue: "low",
            options: [{ value: "low" }, { value: "high" }],
          },
        ],
      });
      break;
    case "session/set_config_option":
      if (config) {
        const { configId, value } = message.params;
        if (configId === "model") config = configurations[1];
        else {
          const option = config.find((item) => item.id === configId);
          if (!option?.options?.some((item) => item.value === value)) {
            send({
              id: message.id,
              error: {
                code: -32602,
                message: "Unsupported option after model switch",
              },
            });
            break;
          }
          option.currentValue = value;
        }
      }
      reply({ configOptions: config ?? [] });
      break;
    case "session/prompt":
      turn++;
      pending = message.id;
      send({
        id: `unsupported-${turn}`,
        method: "terminal/create",
        params: {},
      });
      send({
        id: `permission-${turn}`,
        method: "session/request_permission",
        params: {
          sessionId,
          options: [
            { kind: "allow_always", optionId: "always" },
            { kind: "allow_once", optionId: "once" },
          ],
        },
      });
      break;
    default:
      if (message.id === `permission-${turn}`) {
        const update = (value) =>
          send({
            method: "session/update",
            params: { sessionId, update: value },
          });
        update({
          sessionUpdate: "tool_call",
          toolCallId: `read-${turn}`,
          title: "Read",
        });
        const value = JSON.stringify({
          turn,
          permission: message.result.outcome.optionId,
        });
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: value.slice(0, 8) },
        });
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: value.slice(8) },
        });
        send({
          id: pending,
          result: {
            stopReason: "end_turn",
            usage: { inputTokens: turn, outputTokens: turn * 2 },
          },
        });
      }
  }
});

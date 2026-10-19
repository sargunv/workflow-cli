#!/usr/bin/env node
// Offline subprocess fixture. No vendor CLI or network requests.
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  if (process.env.WORKFLOW_FIXTURE_DISCOVERY_PID) {
    fs.writeFileSync(
      process.env.WORKFLOW_FIXTURE_DISCOVERY_PID,
      JSON.stringify({ pid: process.pid, supervisor: process.ppid }),
    );
  }
  setTimeout(
    () => {
      console.log("fixture-claude 1.0");
      process.exit(0);
    },
    Number(process.env.WORKFLOW_FIXTURE_DISCOVERY_DELAY ?? 0),
  );
} else {
  if (process.env.WORKFLOW_FIXTURE_ARGV) {
    fs.appendFileSync(
      process.env.WORKFLOW_FIXTURE_ARGV,
      JSON.stringify(process.argv.slice(2)) + "\n",
    );
  }

  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    prompt += chunk;
  });
  process.stdin.on("end", () => {
    if (process.env.WORKFLOW_FIXTURE_CALLS) {
      fs.appendFileSync(process.env.WORKFLOW_FIXTURE_CALLS, prompt + "\n");
    }
    if (prompt === "limited" && process.env.WORKFLOW_FIXTURE_USAGE_LIMIT) {
      process.stdout.write(
        fs.readFileSync(process.env.WORKFLOW_FIXTURE_USAGE_LIMIT),
      );
      // The runtime must cancel the owned process without waiting for its exit.
      setInterval(() => {}, 1000);
      return;
    }
    if (prompt === "fail with result") {
      console.log(
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["parsed failure"],
        }),
      );
      process.exitCode = 1;
      return;
    }
    if (prompt === "fail with stderr") {
      process.stderr.write("stderr failure\n");
      process.exitCode = 1;
      return;
    }

    console.log(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "read-1", name: "Read", input: {} },
          ],
        },
      }),
    );
    if (prompt.startsWith("block")) {
      setInterval(() => {}, 1000);
      return;
    }
    console.log(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: prompt,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });
}

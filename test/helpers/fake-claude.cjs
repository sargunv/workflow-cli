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
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    prompt += chunk;
  });
  process.stdin.on("end", () => {
    if (process.env.WORKFLOW_FIXTURE_CALLS) {
      fs.appendFileSync(process.env.WORKFLOW_FIXTURE_CALLS, prompt + "\n");
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

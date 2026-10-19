// Explicit, quota-consuming verification. Never imported by the offline suite.
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";

import { defaultTransport } from "../src/config.ts";
import { createDrivers } from "../src/drivers/index.ts";
import { backendName, effort, errorText } from "../src/types.ts";
import type { DriverSession } from "../src/types.ts";

const program = new Command()
  .description("One deliberate live backend probe; consumes subscription quota")
  .requiredOption("--backend <name>")
  .requiredOption("--model <id>")
  .option("--effort <level>")
  .parse();
const options = program.opts<{
  backend: string;
  model: string;
  effort?: string;
}>();
const backend = backendName.parse(options.backend);
const level = options.effort ? effort.parse(options.effort) : undefined;
const cwd = await mkdtemp(join(tmpdir(), `workflow-live-${backend}-`));
const transcript = join(cwd, "transcript.jsonl");
writeFileSync(transcript, "", { mode: 0o600 });
writeFileSync(join(cwd, "probe.txt"), "731\n", { mode: 0o600 });
const driver = createDrivers({ ...defaultTransport, agentTimeoutMs: 60000 })[
  backend
];
const signal = AbortSignal.timeout(90000);
let session: DriverSession | undefined;
try {
  const detection = await driver.detect(cwd, signal);
  writeFileSync(
    join(cwd, "detection.json"),
    JSON.stringify(detection, null, 2),
    { mode: 0o600 },
  );
  if (!detection.available) {
    throw Error(detection.notes.join("; "));
  }
  const schema =
    detection.structured === "native"
      ? {
          type: "object",
          properties: { code: { type: "number" } },
          required: ["code"],
          additionalProperties: false,
        }
      : undefined;
  const first = await driver.run({
    cwd,
    model: options.model,
    effort: level,
    signal,
    prompt: `Use a read tool to read ${join(cwd, "probe.txt")}. Return only JSON {"code": <number read>}. Do not edit files or run any other task.`,
    systemAppend:
      "You are a leaf protocol probe. Do not delegate. Perform only the exact benign read requested, then return the literal JSON result.",
    toolPolicy: detection.toolPolicies.includes("read-only")
      ? "read-only"
      : undefined,
    keepSession: detection.correction === "session",
    schema,
    onEvent(event) {
      appendFileSync(transcript, JSON.stringify(event) + "\n");
    },
  });
  session = first.session;
  const firstRecord = {
    text: first.text,
    structured: first.structured,
    usage: first.usage,
    exitInfo: first.exitInfo,
  };
  writeFileSync(join(cwd, "first.json"), JSON.stringify(firstRecord, null, 2), {
    mode: 0o600,
  });
  if (first.exitInfo.code !== 0 || first.exitInfo.error) {
    throw Error(first.exitInfo.error ?? "First turn failed");
  }
  if (session) {
    appendFileSync(
      transcript,
      JSON.stringify({ type: "probe-second-turn" }) + "\n",
    );
    const second = await session.prompt(
      'Without using tools, recall the number you just read. Return only JSON {"remembered": <that number>}.',
    );
    writeFileSync(join(cwd, "second.json"), JSON.stringify(second, null, 2), {
      mode: 0o600,
    });
    if (second.exitInfo.code !== 0 || second.exitInfo.error) {
      throw Error(second.exitInfo.error ?? "Second turn failed");
    }
  }
  process.stdout.write(
    `Probe finished. Inspect results and transcript: ${cwd}\n`,
  );
} catch (error) {
  process.stderr.write(`${errorText(error)}\nProbe artifacts: ${cwd}\n`);
  process.exitCode = 1;
} finally {
  await session?.close();
}

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { inspectReport } from "../src/runtime/control.js";
import { command, final, onlyRunId, project, spawnCli } from "./helpers/cli.js";
import { fixturePath } from "./helpers/common.js";

void test("skill installation copies linked references and updates bundled files", async () => {
  const p = await project("");
  const destination = join(p.cwd, "skills", "workflow");
  const source = fileURLToPath(new URL("../skills/workflow/", import.meta.url));
  const bundled = (path: string) => readFile(join(source, path), "utf8");
  const installed = (path: string) => readFile(join(destination, path), "utf8");

  const first = await command(["skill", "--install", destination], p);
  assert.equal(first.code, 0, first.stderr);
  for (const path of [
    "SKILL.md",
    "references/claude.md",
    "references/gpt.md",
  ]) {
    assert.equal(await installed(path), await bundled(path));
  }

  await writeFile(join(destination, "SKILL.md"), "old entrypoint");
  await writeFile(join(destination, "references", "claude.md"), "old guide");
  await writeFile(join(destination, "references", "local.md"), "local notes");
  const update = await command(["skill", "--install", destination], p);
  assert.equal(update.code, 0, update.stderr);
  for (const path of ["SKILL.md", "references/claude.md"]) {
    assert.equal(await installed(path), await bundled(path));
  }
  assert.equal(await installed("references/local.md"), "local notes");

  const printed = await command(["skill", "--print"], p);
  assert.equal(printed.stdout, await bundled("SKILL.md"));
});

void test("a recorded usage limit stops the run with exit 130 and resume retries the interrupted leaf", async () => {
  const p = await project(
    "await agent('seed'); try { const result=await agent('limited'); if(result===null) log('dropped work'); } catch(e) { log('caught'); } return agent('after');",
  );
  p.env.WORKFLOW_FIXTURE_USAGE_LIMIT = fixturePath("claude-usage-limit.jsonl");
  const stopped = await command(["run", p.script, "--json"], p);
  assert.equal(stopped.code, 130, stopped.stderr);
  const report = final(stopped.stdout);
  assert.equal(report.status, "cancelled");
  // The script never sees the interrupted call as a null or an exception.
  assert.deepEqual(report.logs, []);
  assert.deepEqual(report.usageLimit, {
    backend: "claude",
    agentId: 2,
    message: "Your weekly Opus usage limit has been reached.",
    limit: "seven_day_opus",
    resetsAt: "2026-10-13T00:00:00.000Z",
  });
  const shown = await command(["show", report.runId], p);
  assert.match(shown.stdout, /seven_day_opus.*2026-10-13/);

  delete p.env.WORKFLOW_FIXTURE_USAGE_LIMIT;
  const resumed = await command(
    ["run", p.script, "--resume", report.runId, "--json"],
    p,
  );
  assert.equal(resumed.code, 0, resumed.stderr);
  const completed = final(resumed.stdout);
  assert.equal(completed.result, "after");
  assert.equal(completed.counts.cached, 1);
  assert.equal(
    await readFile(join(p.cwd, "calls"), "utf8"),
    "seed\nlimited\nlimited\nafter\n",
  );
});

void test("model selections reach Claude unchanged and --model sets the run default", async () => {
  const models = ["opus", "claude-opus-5-5", "provider/custom-deployment"];
  const p = await project(
    `return parallel([...${JSON.stringify(models)}.map(model => () => agent('model test', {model})), () => agent('default')]);`,
  );
  const argvLog = join(p.cwd, "argv.jsonl");
  p.env.WORKFLOW_FIXTURE_ARGV = argvLog;
  const run = await command(
    ["run", p.script, "--model", "fixture-model", "--json"],
    p,
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(final(run.stdout).status, "completed");
  const selected = (await readFile(argvLog, "utf8"))
    .trim()
    .split("\n")
    .map((line): string[] => JSON.parse(line))
    .map((argv) => argv[argv.indexOf("--model") + 1]);
  assert.deepEqual(new Set(selected), new Set([...models, "fixture-model"]));

  const empty = await command(["run", p.script, "--model", "", "--json"], p);
  assert.equal(empty.code, 1);
  assert.equal(
    (await readFile(argvLog, "utf8")).trim().split("\n").length,
    selected.length,
  );
});

void test("a closed stdout pipe is quiet and cancels owned foreground work", async () => {
  const p = await project("return agent('block closed pipe');");
  const child = spawnCli(["run", p.script, "--json"], p);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdout.destroy();
  assert.equal(await closed, 0, stderr);
  assert.doesNotMatch(stderr, /EPIPE|Unhandled|node:events/);
  const id = await onlyRunId(p);
  assert.equal((await inspectReport(p.root, id)).status, "cancelled");
});

void test("info reports backends and capabilities as JSON and text", async () => {
  const p = await project("return null;");
  const json = await command(["info", "--json"], p);
  assert.equal(json.code, 0, json.stderr);
  const info = z
    .object({
      runtime: z.object({
        defaultBackend: z.string(),
        concurrency: z.number(),
      }),
      backends: z.array(
        z.object({
          name: z.string(),
          available: z.boolean(),
          transport: z.enum(["cli", "acp"]),
          models: z.array(
            z.object({
              id: z.string(),
              default: z.boolean().optional(),
              efforts: z.array(z.string()),
            }),
          ),
          notes: z.array(z.string()),
        }),
      ),
      profiles: z.record(z.string(), z.unknown()),
    })
    .parse(JSON.parse(json.stdout));
  assert.deepEqual(
    info.backends.filter((b) => b.available).map((b) => b.name),
    ["claude"],
  );

  const human = await command(["info"], p);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /claude\s+available/);
  assert.match(human.stdout, /qwen\s+missing/);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { configSchema } from "../src/config.js";
import { capture } from "../src/drivers/process.js";
import { readTrace } from "../src/runtime/replay.js";
import { runWorkflow } from "../src/runtime/run.js";
import type { RunRequest } from "../src/runtime/run.js";
import { ProcessOwnershipError } from "../src/types.js";
import type {
  Driver,
  DriverRequest,
  DriverResult,
  BackendName,
} from "../src/types.js";
const header =
  "export const meta = {name:'run-test',description:'Test the complete run lifecycle'};\n";
async function fixture(
  run: (request: DriverRequest) => Promise<DriverResult>,
): Promise<RunRequest> {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-run-"));
  const driver: Driver = {
    async detect() {
      return {
        name: "claude",
        available: true,
        notes: [],
        transport: "cli",
        models: [],
        structured: "native",
        correction: "turn",
        worktree: true,
        toolPolicies: ["read-only"],
        minimal: true,
        usage: true,
      };
    },
    run,
  };
  const drivers: Record<BackendName, Driver> = {
    claude: driver,
    codex: driver,
    cursor: driver,
    opencode: driver,
    kimi: driver,
    qwen: driver,
  };
  return {
    source: header + "return null;",
    scriptPath: join(cwd, "main.js"),
    cwd,
    root: join(cwd, "runs"),
    args: null,
    config: configSchema.parse({ concurrency: 2 }),
    drivers,
    signal: new AbortController().signal,
    onEvent() {},
  };
}
async function initializeRepo(cwd: string) {
  await capture("git", ["init", "-q"], cwd);
  await capture("git", ["config", "user.email", "test@example.invalid"], cwd);
  await capture("git", ["config", "user.name", "Test"], cwd);
  await capture("git", ["config", "commit.gpgsign", "false"], cwd);
  await capture("git", ["config", "core.hooksPath", "/dev/null"], cwd);
  await writeFile(join(cwd, ".gitignore"), ".workflow/\nruns/\n");
  await capture("git", ["add", ".gitignore"], cwd);
  await capture("git", ["commit", "-qm", "initial"], cwd);
}

void test("usage limits stop admission, retain changed work and resume without caching null", async () => {
  let exhausted = true;
  const calls: string[] = [];
  const request = await fixture(async (task) => {
    calls.push(task.prompt);
    if (task.prompt === "ordinary failure") {
      return { text: "", exitInfo: { code: 1, error: "ordinary failure" } };
    }

    if (exhausted && task.prompt === "active") {
      await new Promise((resolve) =>
        task.signal.addEventListener("abort", resolve, { once: true }),
      );
      throw new Error("active sibling cancelled");
    }

    if (exhausted && task.prompt === "limited") {
      await writeFile(join(task.cwd, "partial.txt"), "unfinished work");
      return {
        text: "",
        usageLimit: {
          message: "Quota exhausted",
          limit: "five_hour",
          resetsAt: "2026-10-13T00:00:00Z",
        },
        exitInfo: { code: 1 },
      };
    }

    return { text: task.prompt, exitInfo: { code: 0 } };
  });
  await initializeRepo(request.cwd);
  request.source =
    header +
    "await agent('ordinary failure'); await agent('seed'); return parallel([()=>agent('active'),()=>agent('limited',{backend:'codex',isolation:'worktree'}),()=>agent('queued')]);";
  const first = await runWorkflow(request);
  assert.equal(first.status, "cancelled", first.error ?? "");
  assert.match(
    first.error ?? "",
    /codex usage limit.*five_hour.*2026-10-13.*Resume/,
  );
  assert.equal(first.usageLimit?.backend, "codex");
  assert.equal(first.usageLimit?.agentId, 4);
  assert.deepEqual(calls, ["ordinary failure", "seed", "active", "limited"]);
  const trace = readTrace(join(first.directory, "replay.jsonl"));
  assert.deepEqual(
    trace.filter((event) => event.type === "finish").map((event) => event.id),
    [1, 2],
  );
  const tree = first.agents.find(
    (agent) => agent.prompt === "limited",
  )?.worktree;
  assert.ok(tree?.kept);
  assert.equal(
    await readFile(join(tree.path, "partial.txt"), "utf8"),
    "unfinished work",
  );

  exhausted = false;
  calls.length = 0;
  const resumed = await runWorkflow({ ...request, resume: first.runId });
  assert.equal(resumed.status, "completed", resumed.error ?? "");
  assert.deepEqual(resumed.result, ["active", "limited", "queued"]);
  assert.deepEqual(calls.toSorted(), ["active", "limited", "queued"]);
  assert.equal(resumed.agents.filter((agent) => agent.cached).length, 2);
  assert.equal(resumed.usageLimit, undefined);
});

void test("a streaming refusal stops the root before driver exit and cannot be caught as null", async () => {
  let aborted = false;
  const request = await fixture(async (task) => {
    task.onEvent({
      type: "usage-limit",
      usageLimit: { message: "You've hit your usage limit" },
    });
    aborted = task.signal.aborted;
    return {
      text: "partial answer",
      exitInfo: { code: 1, error: "terminated" },
    };
  });
  request.source =
    header +
    "try { const result=await agent('limited'); if(result===null) log('dropped work'); } catch(e) { log('caught'); } return 'hidden interruption';";
  const report = await runWorkflow(request);
  assert.equal(aborted, true);
  assert.equal(report.status, "cancelled");
  assert.deepEqual(report.logs, []);
  assert.equal(report.result, null);
  assert.equal(
    readTrace(join(report.directory, "replay.jsonl")).filter(
      (event) => event.type === "finish",
    ).length,
    0,
  );
});

void test("quota exhaustion during session correction closes the session without more retries", async () => {
  let corrections = 0;
  let closed = 0;
  const request = await fixture(async () => ({
    text: "invalid JSON",
    exitInfo: { code: 0 },
    session: {
      async prompt() {
        corrections++;
        return {
          text: "",
          usageLimit: { message: "usage exhausted" },
          exitInfo: { code: 1 },
        };
      },
      async close() {
        closed++;
      },
    },
  }));
  const detect = request.drivers.claude.detect.bind(request.drivers.claude);
  request.drivers.claude.detect = async (cwd, signal) => ({
    ...(await detect(cwd, signal)),
    correction: "session",
  });
  request.source =
    header +
    "return agent('task',{schema:{type:'object',properties:{value:{type:'string'}}}});";
  const report = await runWorkflow(request);
  assert.equal(report.status, "cancelled", report.error ?? "");
  assert.deepEqual([corrections, closed], [1, 1]);
  assert.equal(readTrace(join(report.directory, "replay.jsonl")).length, 1);
});

void test("uncertain cleanup still fails a quota-interrupted run", async () => {
  const request = await fixture(async (task) => {
    task.onEvent({
      type: "usage-limit",
      usageLimit: { message: "Usage exhausted" },
    });
    throw new ProcessOwnershipError("Backend process ownership uncertain");
  });
  request.source = header + "return agent('limited');";
  const report = await runWorkflow(request);
  assert.equal(report.status, "failed");
  assert.match(report.error ?? "", /ownership uncertain/);
  assert.equal(report.usageLimit?.backend, "claude");
  assert.equal(readTrace(join(report.directory, "replay.jsonl")).length, 1);
});

void test("integrated execution enforces concurrency, records usage and fully replays", async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const request = await fixture(async (request) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) =>
      setTimeout(resolve, request.prompt === "A" ? 25 : 5),
    );
    active--;
    request.onEvent({ type: "tool", id: "one", text: "Read" });
    request.onEvent({ type: "raw", raw: { type: "backend-record" } });
    return {
      text: request.prompt,
      usage: { input: 4, output: 2 },
      exitInfo: { code: 0 },
    };
  });
  request.source =
    header +
    "return pipeline(['A','B','C'], x => agent(x), x => agent('verify '+x));";
  const first = await runWorkflow(request);
  assert.equal(first.status, "completed");
  assert.equal(peak, 2);
  assert.equal(first.agents.length, 6);
  assert.equal(first.agents[0]?.toolCalls, 1);
  assert.equal(first.agents[0]?.usage?.cost, undefined);
  assert.match(
    await readFile(join(first.directory, "transcripts", "1.jsonl"), "utf8"),
    /backend-record/,
  );
  const second = await runWorkflow({ ...request, resume: first.runId });
  assert.equal(second.status, "completed");
  assert.deepEqual(second.result, first.result);
  assert.equal(calls, 6);
  assert.ok(second.agents.every((agent) => agent.cached));
});
void test("structured output retries are bounded and bad outputs never reach scripts", async () => {
  let calls = 0;
  const prompts: DriverRequest[] = [];
  const request = await fixture(async (invocation) => {
    calls++;
    prompts.push(invocation);
    return { text: "not JSON", exitInfo: { code: 0 } };
  });
  request.source =
    header +
    "return agent('MAKE THE ORIGINAL EDIT', {schema:{type:'object',properties:{value:{type:'string'}},required:['value']}});";
  const report = await runWorkflow(request);
  assert.equal(report.result, null);
  assert.equal(calls, 3);
  assert.equal(report.agents[0]?.status, "errored");
  assert.match(report.agents[0]?.reason ?? "", /attempt 3/);
  assert.equal(prompts[0]?.prompt, "MAKE THE ORIGINAL EDIT");
  for (const correction of prompts.slice(1)) {
    assert.equal(correction.prompt.includes("MAKE THE ORIGINAL EDIT"), false);
    assert.match(correction.prompt, /not JSON/);
    assert.equal(correction.toolPolicy, "read-only");
  }
});

void test("session corrections preserve context, per-turn transcripts and cleanup", async () => {
  let calls = 0;
  let corrections = 0;
  let closed = 0;
  const request = await fixture(async (invocation) => {
    calls++;
    assert.equal(invocation.keepSession, true);
    invocation.onEvent({ type: "raw", raw: "initial" });
    return {
      text: "invalid",
      usage: { input: 1, output: 1 },
      exitInfo: { code: 0 },
      session: {
        async prompt(text) {
          corrections++;
          assert.equal(text.includes("MAKE THE ORIGINAL EDIT"), false);
          invocation.onEvent({ type: "raw", raw: `correction ${corrections}` });
          return {
            text: corrections === 1 ? "still invalid" : '{"value":"done"}',
            usage: { input: 2, output: 2 },
            exitInfo: { code: 0 },
          };
        },
        async close() {
          closed++;
        },
      },
    };
  });
  const detect = request.drivers.claude.detect.bind(request.drivers.claude);
  request.drivers.claude.detect = async (cwd, signal) => ({
    ...(await detect(cwd, signal)),
    correction: "session",
    structured: "prompted",
  });
  request.source =
    header +
    "return agent('MAKE THE ORIGINAL EDIT',{schema:{type:'object',properties:{value:{type:'string'}},required:['value']}});";
  const report = await runWorkflow(request);
  assert.deepEqual(report.result, { value: "done" });
  assert.equal(report.agents[0]?.reason, undefined);
  assert.equal(report.agents[0]?.usage?.output, 5);
  assert.deepEqual([calls, corrections, closed], [1, 2, 1]);
  const records = (
    await readFile(join(report.directory, "transcripts", "1.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    records.filter((item) => item.type === "raw").map((item) => item.attempt),
    [0, 1, 2],
  );
});

void test("a failed correction closes its retained session without rerunning the task", async () => {
  let calls = 0;
  let closed = 0;
  const request = await fixture(async () => {
    calls++;
    return {
      text: "invalid",
      exitInfo: { code: 0 },
      session: {
        async prompt() {
          throw Error("Correction connection lost");
        },
        async close() {
          closed++;
        },
      },
    };
  });
  const detect = request.drivers.claude.detect.bind(request.drivers.claude);
  request.drivers.claude.detect = async (cwd, signal) => ({
    ...(await detect(cwd, signal)),
    correction: "session",
    structured: "prompted",
  });
  request.source =
    header +
    "return agent('task',{schema:{type:'object',properties:{value:{type:'string'}},required:['value']}});";
  const report = await runWorkflow(request);
  assert.equal(report.result, null);
  assert.match(report.agents[0]?.reason ?? "", /connection lost/);
  assert.deepEqual([calls, closed], [1, 1]);
});
void test("cancellation prevents queued spawns and settles active driver work", async () => {
  let calls = 0;
  const controller = new AbortController();
  const request = await fixture(async (request) => {
    calls++;
    if (calls === 2) {
      setImmediate(() => controller.abort(new Error("test cancellation")));
    }
    await new Promise((resolve) =>
      request.signal.addEventListener("abort", resolve, { once: true }),
    );
    return { text: "", exitInfo: { code: 1, error: "aborted" } };
  });
  request.signal = controller.signal;
  request.source =
    header +
    "return parallel(Array.from({length:10}, (_,i) => () => agent('task '+i)));";
  const report = await runWorkflow(request);
  assert.equal(report.status, "cancelled");
  assert.equal(calls, 2);
  assert.equal(report.agents.length, 10);
  assert.ok(report.agents.every((agent) => agent.status === "skipped"));
});
void test("child workflow shares arguments and enforces one nesting level", async () => {
  const request = await fixture(async (request) => ({
    text: request.prompt,
    exitInfo: { code: 0 },
  }));
  await writeFile(
    join(request.cwd, "child.js"),
    header + "return agent(args.message)",
  );
  request.source =
    header + "return workflow('./child.js', {message:'child input'})";
  const report = await runWorkflow(request);
  assert.equal(report.status, "completed");
  assert.equal(report.result, "child input");
  assert.equal(report.agents[0]?.phase, "▸ run-test");
  await writeFile(
    join(request.cwd, "child.js"),
    header + "return workflow('./child.js')",
  );
  const bad = await runWorkflow(request);
  assert.equal(bad.status, "failed");
  assert.match(bad.error ?? "", /one level/);
});
void test("named child preparation preserves replay and unawaited child is cancelled", async () => {
  const { mkdir } = await import("node:fs/promises");
  let calls = 0;
  const request = await fixture(async (request) => {
    calls++;
    await new Promise((resolve) =>
      setTimeout(resolve, request.prompt === "parent" ? 40 : 5),
    );
    return { text: request.prompt, exitInfo: { code: 0 } };
  });
  await mkdir(join(request.cwd, ".workflow", "workflows"), { recursive: true });
  await writeFile(
    join(request.cwd, ".workflow", "workflows", "child.js"),
    header + "return agent('child')",
  );
  request.source =
    header + "return parallel([()=>agent('parent'),()=>workflow('child')])";
  const first = await runWorkflow(request);
  const second = await runWorkflow({ ...request, resume: first.runId });
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.deepEqual(second.result, first.result);
  assert.equal(calls, 2);
  await writeFile(
    join(request.cwd, ".workflow", "workflows", "child.js"),
    header + "await agent('child'); log('late child'); return 'child'",
  );
  request.source = header + "workflow('child'); return 'parent done'";
  const report = await runWorkflow(request);
  const snapshot = JSON.stringify(report);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(JSON.stringify(report), snapshot);
  assert.deepEqual(report.logs, []);
});
void test("replay waits until a VM has drained runnable promise jobs", async () => {
  let calls = 0;
  const request = await fixture(async (request) => {
    calls++;
    if (request.prompt === "a") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { text: request.prompt, exitInfo: { code: 0 } };
  });
  request.source =
    header +
    "const a=agent('a'); for(let i=0;i<5000;i++) await Promise.resolve(); const b=agent('b'); return [await a,await b];";
  const first = await runWorkflow(request);
  const second = await runWorkflow({ ...request, resume: first.runId });
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.deepEqual(second.result, first.result);
  assert.equal(calls, 2);
});
void test("parallel cannot hide terminal journal persistence failure as a successful null", async () => {
  const { rm, mkdir } = await import("node:fs/promises");
  const request = await fixture(async (request) => ({
    text: request.prompt,
    exitInfo: { code: 0 },
  }));
  request.source =
    header + "return parallel([()=>agent('one'),()=>agent('two')]);";
  request.onReady = async (run) => {
    await rm(join(run.store.directory, "journal.jsonl"));
    await mkdir(join(run.store.directory, "journal.jsonl"));
  };
  const report = await runWorkflow(request);
  assert.equal(report.status, "failed");
  assert.match(report.error ?? "", /EISDIR/);
  assert.deepEqual(report.activeAgents, []);
});

void test("uncertain process cleanup fails the run and preserves even a clean worktree", async () => {
  const { access } = await import("node:fs/promises");
  const request = await fixture(async () => {
    throw new ProcessOwnershipError(
      "Backend output remained open after supervisor exit",
    );
  });
  await initializeRepo(request.cwd);
  request.source =
    header + "return parallel([()=>agent('work',{isolation:'worktree'})]);";
  const report = await runWorkflow(request);
  assert.equal(report.status, "failed");
  assert.match(report.error ?? "", /output remained open/);
  assert.equal(report.agents[0]?.status, "errored");
  const worktree = report.agents[0]?.worktree;
  assert.ok(worktree?.kept);
  assert.equal(
    await capture("git", ["status", "--porcelain"], worktree.path),
    "",
  );
  await access(worktree.path);
});

void test("literal object children preflight before parent effects and named resolution stays stable", async () => {
  const { mkdir, rm } = await import("node:fs/promises");
  let calls = 0;
  const request = await fixture(async () => {
    calls++;
    await rm(join(request.cwd, ".workflow", "workflows", "child.js"));
    return { text: "removed source", exitInfo: { code: 0 } };
  });
  await writeFile(join(request.cwd, "broken.js"), "not a workflow");
  request.source =
    header +
    "await agent('side effect'); return workflow({scriptPath:'./broken.js'});";
  assert.equal((await runWorkflow(request)).status, "failed");
  assert.equal(calls, 0);
  await mkdir(join(request.cwd, ".workflow", "workflows"), { recursive: true });
  await writeFile(
    join(request.cwd, ".workflow", "workflows", "child.js"),
    header + "return 'launch snapshot';",
  );
  request.source =
    header + "await agent('remove original'); return workflow('child');";
  const report = await runWorkflow(request);
  assert.equal(report.result, "launch snapshot");
  assert.equal(report.status, "completed");
});

void test("partial worktree setup failures retain structured ownership and the actual cause", async () => {
  const { access } = await import("node:fs/promises");
  let called = false;
  const request = await fixture(async () => {
    called = true;
    return { text: "unused", exitInfo: { code: 0 } };
  });
  await initializeRepo(request.cwd);
  request.config.sharedPaths = [{ path: ".gitignore", mode: "copy" }];
  request.source = header + "return agent('work',{isolation:'worktree'});";
  const report = await runWorkflow(request);
  assert.equal(called, false);
  assert.equal(report.result, null);
  const agent = report.agents[0];
  assert.match(agent?.reason ?? "", /Shared path collides with a tracked file/);
  assert.ok(agent?.worktree?.kept);
  assert.ok(agent.worktree.base);
  assert.ok(agent.worktree.branch.startsWith("workflow/"));
  await access(agent.worktree.path);
});

void test("parallel cannot hide a dynamically loaded child snapshot write failure", async () => {
  const request = await fixture(async () => ({
    text: "unused",
    exitInfo: { code: 0 },
  }));
  await writeFile(join(request.cwd, "child.js"), header + "return 1;");
  request.source =
    header + "const ref='./child.js'; return parallel([()=>workflow(ref)]);";
  request.onReady = async (run) => {
    await writeFile(join(run.store.directory, "children"), "fault injection");
  };
  const report = await runWorkflow(request);
  assert.equal(report.status, "failed");
  assert.match(report.error ?? "", /EEXIST/);
});

void test("resume reconstructs missing generated children and prefers edited current sources", async () => {
  const { rm } = await import("node:fs/promises");
  let calls = 0;
  const request = await fixture(async (invocation) => {
    calls++;
    if (invocation.prompt === "generate") {
      await writeFile(
        join(request.cwd, "generated.js"),
        header + "return agent('inner');",
      );
    }
    return { text: invocation.prompt, exitInfo: { code: 0 } };
  });
  request.source =
    header +
    "await agent('generate'); const ref='./generated.js'; return workflow(ref);";
  const first = await runWorkflow(request);
  assert.equal(first.result, "inner");
  await rm(join(request.cwd, "generated.js"));
  const second = await runWorkflow({ ...request, resume: first.runId });
  assert.equal(second.result, "inner");
  assert.equal(second.status, "completed");
  assert.equal(calls, 2);
  assert.ok(second.agents.every((agent) => agent.cached));
  await writeFile(
    join(request.cwd, "generated.js"),
    header + "await agent('inner'); return 'edited child';",
  );
  const third = await runWorkflow({ ...request, resume: second.runId });
  assert.equal(third.result, "edited child");
  assert.equal(
    calls,
    2,
    "unchanged leaf calls stay cached after local child code edits",
  );
});

void test("literal profiles preflight their backend and computed concurrent selections share discovery", async () => {
  let calls = 0;
  const request = await fixture(async () => {
    calls++;
    return { text: "ok", exitInfo: { code: 0 } };
  });
  const available = request.drivers.codex;
  request.drivers.codex = {
    ...available,
    async detect() {
      return {
        ...(await available.detect(request.cwd)),
        available: false,
        notes: ["missing fixture"],
      };
    },
  };
  request.config.profiles.reviewer = { backend: "codex" };
  request.source =
    header +
    "await agent('must not run'); return agent('review', {profile:'reviewer'});";
  const missing = await runWorkflow(request);
  assert.equal(missing.status, "failed");
  assert.match(missing.error ?? "", /missing fixture/);
  assert.equal(calls, 0);
  let discoveries = 0;
  request.drivers.codex = {
    ...available,
    async detect() {
      discoveries++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return available.detect(request.cwd);
    },
  };
  request.source =
    header +
    "const backend = args; return parallel([()=>agent('a',{backend}),()=>agent('b',{backend})]);";
  request.args = "codex";
  const concurrent = await runWorkflow(request);
  assert.equal(
    concurrent.status,
    "completed",
    concurrent.error ?? "unexpected failure",
  );
  assert.equal(discoveries, 1);
  assert.equal(calls, 2);
  assert.equal(concurrent.agents[0]?.usage?.cost, undefined);
});

void test("validation transcript write failure cannot become a successful parallel null", async () => {
  let directory = "";
  const request = await fixture(async () => {
    await mkdir(join(directory, "transcripts", "1.jsonl"));
    return { text: "invalid JSON", exitInfo: { code: 0 } };
  });
  request.onEvent = (event) => {
    if (event.runId) {
      directory = join(request.root ?? "", event.runId);
    }
  };
  request.source =
    header +
    "return parallel([()=>agent('task',{schema:{type:'object',properties:{}}})]);";
  const report = await runWorkflow(request);
  assert.equal(report.status, "failed");
  assert.match(report.error ?? "", /EISDIR/);
});

void test("stop leaves running and queued calls live on resume while intentional skips stay cached", async () => {
  const controller = new AbortController();
  let stopping = true;
  let started = 0;
  const calls: string[] = [];
  const request = await fixture(async (task) => {
    calls.push(task.prompt);
    if (stopping && task.prompt !== "seed") {
      if (++started === 2) {
        setImmediate(() => controller.abort(new Error("stop fixture")));
      }
      await new Promise((resolve) =>
        task.signal.addEventListener("abort", resolve, { once: true }),
      );
      throw Error("interrupted");
    }
    return { text: task.prompt, exitInfo: { code: 0 } };
  });
  request.signal = controller.signal;
  request.source =
    header +
    "await agent('seed'); return parallel(['a','b','c'].map(item=>()=>agent(item)));";
  const first = await runWorkflow(request);
  assert.equal(first.status, "cancelled");
  assert.equal(
    first.agents.filter((agent) => agent.status === "done").length,
    1,
  );
  assert.equal(
    first.agents.filter((agent) => agent.status === "skipped").length,
    3,
  );
  stopping = false;
  calls.length = 0;
  const resumed = await runWorkflow({
    ...request,
    signal: new AbortController().signal,
    resume: first.runId,
  });
  assert.equal(resumed.status, "completed");
  assert.deepEqual(resumed.result, ["a", "b", "c"]);
  assert.equal(resumed.agents.filter((agent) => agent.cached).length, 1);
  assert.deepEqual(calls, ["a", "b", "c"]);

  // An intentional skip is a terminal user choice, unlike stopping the run.
  let skip = (id: number) => {
    void id;
  };
  request.signal = new AbortController().signal;
  request.source = header + "return agent('skip this');";
  request.onStarting = (run) => {
    skip = (id) => run.skip(id);
  };
  request.onEvent = (event) => {
    if (event.type === "agent-started" && event.id) {
      skip(event.id);
    }
  };
  const skipped = await runWorkflow(request);
  assert.equal(skipped.status, "completed");
  assert.equal(skipped.agents[0]?.status, "skipped");
  calls.length = 0;
  const skipResume = await runWorkflow({
    ...request,
    resume: skipped.runId,
    onEvent() {},
  });
  assert.equal(skipResume.result, null);
  assert.equal(skipResume.agents[0]?.cached, true);
  assert.deepEqual(calls, []);
});

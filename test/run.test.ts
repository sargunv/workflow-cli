import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { configSchema } from "../src/config.ts";
import { runWorkflow } from "../src/runtime/run.ts";
import type { RunRequest } from "../src/runtime/run.ts";
import { errorText, ProcessOwnershipError } from "../src/types.ts";
import type {
  Detection,
  Driver,
  DriverRequest,
  DriverResult,
} from "../src/types.ts";
import { git, gitRepo, tempDir } from "./helpers/common.ts";

const header =
  "export const meta = {name:'run-test',description:'Test the complete run lifecycle'};\n";

/** A run whose every backend is the in-process `run` driver. */
async function fixture(
  run: (request: DriverRequest) => Promise<DriverResult>,
  options: { repo?: boolean; detection?: Partial<Detection> } = {},
): Promise<RunRequest> {
  const cwd = options.repo
    ? await gitRepo(".workflow/\nruns/\n")
    : await tempDir("run");
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
        readTools: ["Read", "Grep", "Glob"],
        minimal: true,
        usage: true,
        ...options.detection,
      };
    },
    run,
  };
  return {
    source: header + "return null;",
    scriptPath: join(cwd, "main.js"),
    cwd,
    root: join(cwd, "runs"),
    args: null,
    config: configSchema.parse({ concurrency: 2 }),
    drivers: {
      claude: driver,
      codex: driver,
      cursor: driver,
      grok: driver,
      opencode: driver,
      kimi: driver,
      qwen: driver,
    },
    signal: new AbortController().signal,
    onEvent() {},
  };
}

const untilAborted = (signal: AbortSignal) =>
  new Promise((resolve) =>
    signal.addEventListener("abort", resolve, { once: true }),
  );

const valueSchema =
  "{schema:{type:'object',properties:{value:{type:'string'}},required:['value']}}";

void test("usage limits stop admission, keep changed work and resume the interrupted calls", async () => {
  let exhausted = true;
  const calls: string[] = [];
  const request = await fixture(
    async (task) => {
      calls.push(task.prompt);
      if (task.prompt === "ordinary failure") {
        return { text: "", exitInfo: { code: 1, error: "ordinary failure" } };
      }
      if (exhausted && task.prompt === "active") {
        await untilAborted(task.signal);
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
    },
    { repo: true },
  );
  request.source =
    header +
    "await agent('ordinary failure'); await agent('seed'); return parallel([()=>agent('active'),()=>agent('limited',{backend:'codex',isolation:'worktree'}),()=>agent('queued')]);";
  const first = await runWorkflow(request);
  assert.equal(first.status, "cancelled", first.error ?? "");
  assert.match(first.error ?? "", /codex usage limit/);
  assert.deepEqual(first.usageLimit, {
    backend: "codex",
    agentId: 4,
    message: "Quota exhausted",
    limit: "five_hour",
    resetsAt: "2026-10-13T00:00:00Z",
  });
  assert.deepEqual(calls, ["ordinary failure", "seed", "active", "limited"]);
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
  // The ordinary failure stays a cached null; only interrupted calls rerun.
  assert.deepEqual(calls.toSorted(), ["active", "limited", "queued"]);
  const failed = resumed.agents.find(
    (agent) => agent.prompt === "ordinary failure",
  );
  assert.equal(failed?.cached, true);
  assert.match(failed?.reason ?? "", /ordinary failure/);
  assert.equal(resumed.usageLimit, undefined);
});

void test("uncertain process cleanup fails the run, even after a usage limit, and keeps a clean worktree", async () => {
  let directory = "";
  const request = await fixture(
    async (task) => {
      task.onEvent({
        type: "usage-limit",
        usageLimit: { message: "Usage exhausted" },
      });
      // Observers see the limit before cleanup, which may never finish.
      const saved = JSON.parse(
        await readFile(join(directory, "report.json"), "utf8"),
      );
      assert.equal(saved.usageLimit?.backend, "claude");
      throw new ProcessOwnershipError("Backend output remained open");
    },
    { repo: true },
  );
  request.onStarting = (run) => {
    directory = run.store.directory;
  };
  request.source = header + "return agent('work',{isolation:'worktree'});";
  const report = await runWorkflow(request);
  assert.equal(report.status, "failed");
  assert.match(report.error ?? "", /output remained open/);
  assert.equal(report.usageLimit?.backend, "claude");
  const worktree = report.agents[0]?.worktree;
  assert.ok(worktree?.kept);
  assert.equal(git(worktree.path, "status", "--porcelain"), "");
});

void test("concurrency is enforced and a completed run fully replays", async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const request = await fixture(async (task) => {
    calls++;
    peak = Math.max(peak, ++active);
    await new Promise((resolve) =>
      setTimeout(resolve, task.prompt === "A" ? 20 : 5),
    );
    active--;
    task.onEvent({ type: "raw", raw: { type: "backend-record" } });
    task.onEvent({ type: "tool", id: "t1", text: "Read" });
    return {
      text: task.prompt,
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
  assert.ok(first.agents.every((agent) => agent.toolCalls === 1));
  assert.match(
    await readFile(join(first.directory, "transcripts", "1.jsonl"), "utf8"),
    /backend-record/,
  );
  const second = await runWorkflow({ ...request, resume: first.runId });
  assert.deepEqual(second.result, first.result);
  assert.equal(calls, 6);
  assert.ok(second.agents.every((agent) => agent.cached));
});

void test("corrections narrow an allowlist to the backend's own read tools", async () => {
  const policies: DriverRequest["toolPolicy"][] = [];
  const request = await fixture(
    async (invocation) => {
      policies.push(invocation.toolPolicy);
      return { text: "not JSON", exitInfo: { code: 0 } };
    },
    {
      detection: {
        toolPolicies: ["read-only", "allow", "deny"],
        readTools: ["read_file", "grep", "list_dir"],
      },
    },
  );
  request.source =
    header +
    "return agent('task', {toolPolicy: {allow: ['read_file', 'run_terminal_cmd'], deny: ['grep']}, schema: {type: 'object', properties: {}}});";
  await runWorkflow(request);
  assert.deepEqual(policies.slice(1), [
    { allow: ["read_file"], deny: ["grep"] },
    { allow: ["read_file"], deny: ["grep"] },
  ]);
});

void test("invalid structured output gets bounded read-only corrections and never reaches the script", async () => {
  const prompts: DriverRequest[] = [];
  const request = await fixture(async (invocation) => {
    prompts.push(invocation);
    return { text: "not JSON", exitInfo: { code: 0 } };
  });
  request.source =
    header + `return agent('MAKE THE ORIGINAL EDIT', ${valueSchema});`;
  const report = await runWorkflow(request);
  assert.equal(report.result, null);
  assert.equal(prompts.length, 3);
  assert.equal(report.agents[0]?.status, "errored");
  assert.ok(report.agents[0]?.reason);
  const schema = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  };
  let parseError = "";
  try {
    JSON.parse("not JSON");
  } catch (error) {
    parseError = errorText(error);
  }
  // Corrections must not repeat the task's side effects.
  for (const correction of prompts.slice(1)) {
    assert.equal(correction.prompt.includes("MAKE THE ORIGINAL EDIT"), false);
    assert.equal(correction.toolPolicy, "read-only");
    // Each formatting turn sees the prior result, its validation error and the schema.
    assert.ok(correction.prompt.includes(JSON.stringify("not JSON")));
    assert.ok(correction.prompt.includes(parseError));
    assert.ok(correction.prompt.includes(JSON.stringify(schema)));
  }
});

void test("session corrections keep context and always close the session", async () => {
  const sessionRun = async (
    prompt: (attempt: number) => Promise<DriverResult>,
  ) => {
    let calls = 0;
    let closed = 0;
    const feedback: string[] = [];
    const request = await fixture(
      async (task) => {
        calls++;
        // Real ACP sessions are only retained when the request asks for it.
        assert.equal(task.keepSession, true);
        let attempt = 0;
        return {
          text: "invalid",
          usage: { input: 1, output: 1 },
          exitInfo: { code: 0 },
          session: {
            prompt: (text) => {
              feedback.push(text);
              return prompt(++attempt);
            },
            async close() {
              closed++;
            },
          },
        };
      },
      { detection: { correction: "session", structured: "prompted" } },
    );
    request.source =
      header + `return agent('MAKE THE ORIGINAL EDIT', ${valueSchema});`;
    const report = await runWorkflow(request);
    // Session corrections send validation feedback, never the task again.
    for (const text of feedback) {
      assert.equal(text.includes("MAKE THE ORIGINAL EDIT"), false);
      assert.match(text, /Validation error: /);
      assert.ok(text.includes('"required":["value"]'));
    }
    return { report, calls, closed, feedback };
  };

  const corrected = await sessionRun(async (attempt) => ({
    text: attempt === 1 ? "still invalid" : '{"value":"done"}',
    usage: { input: 2, output: 2 },
    exitInfo: { code: 0 },
  }));
  assert.deepEqual(corrected.report.result, { value: "done" });
  assert.equal(corrected.report.agents[0]?.usage?.output, 5);
  assert.deepEqual([corrected.calls, corrected.closed], [1, 1]);
  assert.equal(corrected.feedback.length, 2);

  const lost = await sessionRun(async () => {
    throw new Error("Correction connection lost");
  });
  assert.equal(lost.report.result, null);
  assert.match(lost.report.agents[0]?.reason ?? "", /connection lost/);
  assert.deepEqual([lost.calls, lost.closed], [1, 1]);

  // A usage limit ends the run instead of spending more corrections.
  const limited = await sessionRun(async () => ({
    text: "",
    usageLimit: { message: "usage exhausted" },
    exitInfo: { code: 1 },
  }));
  assert.equal(limited.report.status, "cancelled");
  assert.deepEqual([limited.calls, limited.closed], [1, 1]);
});

void test("stop leaves started and queued calls live on resume while skips stay cached", async () => {
  const controller = new AbortController();
  let stopping = true;
  const calls: string[] = [];
  const request = await fixture(async (task) => {
    calls.push(task.prompt);
    if (stopping && task.prompt !== "seed") {
      if (calls.length === 3) {
        setImmediate(() => controller.abort(new Error("stop fixture")));
      }
      await untilAborted(task.signal);
      throw new Error("interrupted");
    }
    return { text: task.prompt, exitInfo: { code: 0 } };
  });
  request.signal = controller.signal;
  request.source =
    header +
    "await agent('seed'); return parallel(['a','b','c'].map(item=>()=>agent(item)));";
  const first = await runWorkflow(request);
  assert.equal(first.status, "cancelled");
  // The queued call never started.
  assert.deepEqual(calls, ["seed", "a", "b"]);
  assert.deepEqual(
    first.agents.map((agent) => agent.status),
    ["done", "skipped", "skipped", "skipped"],
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
  assert.deepEqual(calls, ["a", "b", "c"]);

  // An explicit skip is the user's terminal choice, unlike stopping the run.
  let skip = (id: number) => {
    void id;
  };
  const skipping: RunRequest = {
    ...request,
    signal: new AbortController().signal,
    source: header + "return agent('skip this');",
    onStarting: (run) => {
      skip = (id) => {
        run.skip(id);
      };
    },
    onEvent: (event) => {
      if (event.type === "agent-queued" && event.id) {
        skip(event.id);
      }
    },
  };
  calls.length = 0;
  const skipped = await runWorkflow(skipping);
  assert.equal(skipped.status, "completed");
  assert.equal(skipped.agents[0]?.status, "skipped");
  const skipResume = await runWorkflow({
    ...skipping,
    resume: skipped.runId,
    onEvent() {},
  });
  assert.equal(skipResume.agents[0]?.cached, true);
  assert.deepEqual(calls, []);
});

void test("child workflows share arguments and nest only one level", async () => {
  const request = await fixture(async (task) => {
    if (task.prompt === "remove child") {
      await rm(join(task.cwd, "child.js"));
    }
    if (task.prompt === "child") {
      // Settle only after the parent has returned.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { text: task.prompt, exitInfo: { code: 0 } };
  });
  const child = join(request.cwd, "child.js");
  await writeFile(child, header + "return agent(args.message)");
  request.source =
    header + "return workflow('./child.js', {message:'child input'})";
  const report = await runWorkflow(request);
  assert.equal(report.result, "child input");
  await writeFile(child, header + "return workflow('./child.js')");
  const nested = await runWorkflow(request);
  assert.equal(nested.status, "failed");
  assert.match(nested.error ?? "", /one level/);

  // A literal child runs the source prepared at launch, even if an agent removes it.
  await writeFile(child, header + "return agent('prepared child')");
  request.source =
    header + "await agent('remove child'); return workflow('./child.js')";
  const prepared = await runWorkflow(request);
  assert.equal(prepared.result, "prepared child", prepared.error ?? "");

  // An unawaited child is cancelled with the parent and cannot change its report.
  await writeFile(
    child,
    header + "await agent('child'); log('late child'); return 'child'",
  );
  request.source = header + "workflow('./child.js'); return 'parent done'";
  const parent = await runWorkflow(request);
  assert.equal(parent.result, "parent done");
  const snapshot = JSON.stringify(parent);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(JSON.stringify(parent), snapshot);
  assert.deepEqual(parent.logs, []);
});

void test("resume reconstructs missing generated children and prefers edited current sources", async () => {
  let calls = 0;
  const request = await fixture(async (task) => {
    calls++;
    if (task.prompt === "generate") {
      await writeFile(
        join(request.cwd, "generated.js"),
        header + "return agent('inner');",
      );
    }
    return { text: task.prompt, exitInfo: { code: 0 } };
  });
  request.source =
    header +
    "await agent('generate'); const ref='./generated.js'; return workflow(ref);";
  const first = await runWorkflow(request);
  assert.equal(first.result, "inner");
  await rm(join(request.cwd, "generated.js"));
  const second = await runWorkflow({ ...request, resume: first.runId });
  assert.equal(second.result, "inner");
  assert.equal(calls, 2);
  await writeFile(
    join(request.cwd, "generated.js"),
    header + "await agent('inner'); return 'edited child';",
  );
  const third = await runWorkflow({ ...request, resume: second.runId });
  assert.equal(third.result, "edited child");
  // Unchanged leaf calls stay cached after the child's code changes.
  assert.equal(calls, 2);
});

void test("replay waits until the VM has drained runnable promise jobs", async () => {
  let calls = 0;
  const request = await fixture(async (task) => {
    calls++;
    if (task.prompt === "a") {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { text: task.prompt, exitInfo: { code: 0 } };
  });
  request.source =
    header +
    "const a=agent('a'); for(let i=0;i<5000;i++) await Promise.resolve(); const b=agent('b'); return [await a,await b];";
  const first = await runWorkflow(request);
  const second = await runWorkflow({ ...request, resume: first.runId });
  assert.equal(second.status, "completed");
  assert.deepEqual(second.result, first.result);
  assert.equal(calls, 2);
});

void test("preflight rejects broken children and unavailable backends before any agent runs", async () => {
  let calls = 0;
  const request = await fixture(async () => {
    calls++;
    return { text: "ok", exitInfo: { code: 0 } };
  });
  await writeFile(join(request.cwd, "broken.js"), "not a workflow");
  request.source =
    header +
    "await agent('side effect'); return workflow({scriptPath:'./broken.js'});";
  assert.equal((await runWorkflow(request)).status, "failed");

  const available = request.drivers.codex;
  request.drivers.codex = {
    ...available,
    async detect() {
      return { ...(await available.detect(request.cwd)), available: false };
    },
  };
  request.config.profiles.reviewer = { backend: "codex" };
  request.source =
    header +
    "await agent('side effect'); return agent('review', {profile:'reviewer'});";
  assert.equal((await runWorkflow(request)).status, "failed");
  assert.equal(calls, 0);
});

void test("a journal write failure fails the run rather than becoming a null", async () => {
  const request = await fixture(async (task) => ({
    text: task.prompt,
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
});

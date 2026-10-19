import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ManagedProcess } from "../src/drivers/process.js";
import { exited, tempDir, waitFor } from "./helpers/common.js";

// Each fixture is a plain Node program; no vendor process is involved.
function owned(source: string, timeoutMs: number | null = null) {
  let pid: number | undefined;
  const child = new ManagedProcess(process.execPath, ["-e", source], {
    cwd: tmpdir(),
    signal: new AbortController().signal,
    timeoutMs,
    onLine(line) {
      pid ??= Number(line);
    },
  });
  return {
    child,
    pid: () => waitFor(() => pid, "fixture pid"),
  };
}

const spawnDescendant = (options: string, body = "") =>
  `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`${body}setInterval(()=>{},1000)`)}],${options});console.log(c.pid);`;

void test("supervisor preserves backend exit codes and spawn errors", async () => {
  const options = {
    cwd: tmpdir(),
    signal: new AbortController().signal,
    timeoutMs: null,
  };
  const exitedWith = new ManagedProcess(
    process.execPath,
    ["-e", "process.exit(7)"],
    options,
  );
  exitedWith.end();
  assert.equal((await exitedWith.exited).code, 7);
  const missing = new ManagedProcess("/nonexistent/backend", [], options);
  missing.end();
  assert.match((await missing.exited).error ?? "", /ENOENT/);
});

void test("leader exit terminates descendants retaining inherited output pipes", async () => {
  const { child, pid } = owned(
    spawnDescendant("{stdio:'inherit'}") + "c.unref();",
  );
  child.end();
  const exit = await child.exited;
  assert.equal(exit.code, 0);
  assert.equal(exit.error, undefined);
  await exited(await pid());
});

void test("a deadline kills a TERM-ignoring backend and its descendants", async () => {
  const ignoreTerm = "process.on('SIGTERM',()=>{});";
  const { child, pid } = owned(
    ignoreTerm +
      spawnDescendant("{stdio:'inherit'}", ignoreTerm) +
      "setInterval(()=>{},1000)",
  );
  const descendant = await pid();
  child.resetTimeout(50);
  assert.match((await child.exited).error ?? "", /timed out/);
  await exited(descendant);
});

void test("owner death kills the backend without cooperative cleanup", async () => {
  const module = new URL("../src/drivers/process.ts", import.meta.url).href;
  const source = `import {ManagedProcess} from ${JSON.stringify(module)};
    const child = new ManagedProcess(process.execPath,
      ['-e','console.log(process.pid);setInterval(()=>{},1000)'],
      {cwd:process.cwd(),signal:new AbortController().signal,timeoutMs:null,onLine:console.log});
    child.end();`;
  const owner = spawn(
    process.execPath,
    [...process.execArgv, "--input-type=module", "-e", source],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const [chunk] = await once(owner.stdout, "data", {
      signal: AbortSignal.timeout(5000),
    });
    const pid = Number.parseInt(String(chunk), 10);
    owner.kill("SIGKILL");
    await exited(pid);
  } finally {
    owner.kill("SIGKILL");
  }
});

void test("an escaped descendant holding pipes makes cleanup uncertain, not hung", async () => {
  const { child, pid } = owned(
    spawnDescendant("{stdio:'inherit',detached:true}") + "c.unref();",
    3000,
  );
  child.end();
  try {
    const exit = await child.exited;
    assert.equal(exit.cleanupUncertain, true);
    assert.match(exit.error ?? "", /output remained open/);
  } finally {
    // The fixture deliberately escapes the owned group, so clean it up here.
    try {
      process.kill(-(await pid()), "SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

void test("a supervisor that dies without reporting makes cleanup uncertain", async () => {
  const dir = await tempDir("process");
  const pidFile = join(dir, "pid");
  const source = `const fs=require('node:fs');
    fs.closeSync(0);fs.closeSync(1);fs.closeSync(2);
    fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
  const { child } = owned(source, 3000);
  const pid = await waitFor(
    async () =>
      Number(await readFile(pidFile, "utf8").catch(() => "")) || undefined,
    "backend pid",
  );
  try {
    child.child.kill("SIGKILL");
    const exit = await child.exited;
    assert.equal(exit.cleanupUncertain, true);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

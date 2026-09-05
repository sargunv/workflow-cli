import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ManagedProcess } from "../src/drivers/process.js";
void test("leader exit terminates grandchildren retaining inherited output pipes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-process-"));
  const pidFile = join(cwd, "pid");
  const script = join(cwd, "parent.cjs");
  await writeFile(
    script,
    `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();`,
  );
  const process = new ManagedProcess(globalThis.process.execPath, [script], {
    cwd,
    signal: new AbortController().signal,
    timeoutMs: 3000,
  });
  process.end();
  const exit = await process.exited;
  assert.equal(exit.code, 0);
  assert.equal(exit.error, undefined);
  const pid = Number(await readFile(pidFile, "utf8"));
  // Reaping by the OS can trail pipe closure very briefly.
  let gone = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      globalThis.process.kill(pid, 0);
    } catch {
      gone = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(gone, true);
});
void test("deadline kills an unresponsive process and gives an explicit reason", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-process-"));
  const process = new ManagedProcess(
    globalThis.process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    { cwd, signal: new AbortController().signal, timeoutMs: 100 },
  );
  process.end();
  const exit = await process.exited;
  assert.match(exit.error ?? "", /timed out/);
});

void test("owner death kills the backend without cooperative cleanup", async () => {
  const module = new URL("../src/drivers/process.ts", import.meta.url).href;
  const source = `import {ManagedProcess} from ${JSON.stringify(module)};
    const child = new ManagedProcess(process.execPath,
      ['-e','console.log(process.pid);setInterval(()=>{},1000)'],
      {cwd:process.cwd(),signal:new AbortController().signal,onLine:console.log});
    child.end();`;
  const owner = spawn(
    process.execPath,
    [...process.execArgv, "--input-type=module", "-e", source],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const [chunk] = await once(owner.stdout, "data", {
      signal: AbortSignal.timeout(3000),
    });
    const pid = Number.parseInt(String(chunk), 10);
    assert.ok(pid > 0);
    const closed = once(owner, "close");
    owner.kill("SIGKILL");
    await closed;
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Backend survived the death of its owner");
  } finally {
    owner.kill("SIGKILL");
  }
});

void test("supervisor preserves backend exit codes and spawn errors", async () => {
  const options = { cwd: tmpdir(), signal: new AbortController().signal };
  const exited = new ManagedProcess(
    process.execPath,
    ["-e", "process.exit(7)"],
    options,
  );
  exited.end();
  assert.equal((await exited.exited).code, 7);
  const missing = new ManagedProcess(
    "/nonexistent/workflow-backend",
    [],
    options,
  );
  missing.end();
  assert.match((await missing.exited).error ?? "", /ENOENT/);
});

void test("graceful stop retains supervision of TERM-ignoring descendants", async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let pid = 0;
  const owned = new ManagedProcess(
    process.execPath,
    [
      "-e",
      "const c=require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)\"],{stdio:'inherit'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
    ],
    {
      cwd: tmpdir(),
      signal: new AbortController().signal,
      onLine(line) {
        pid = Number(line);
        ready();
      },
    },
  );
  await started;
  owned.stop();
  assert.match((await owned.exited).error ?? "", /stopped/);
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("TERM-ignoring descendant survived stop");
});

void test("an escaped descendant cannot keep process completion waiting on inherited pipes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-process-"));
  const pidFile = join(cwd, "escaped-pid");
  const source = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',detached:true});
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();`;
  const owned = new ManagedProcess(process.execPath, ["-e", source], {
    cwd,
    signal: new AbortController().signal,
    timeoutMs: 3000,
  });
  owned.end();
  try {
    const exit = await owned.exited;
    assert.equal(exit.code, 1);
    assert.match(exit.error ?? "", /output remained open/);
  } finally {
    // This fixture deliberately escapes ordinary group ownership. The test
    // separately owns that group and must clean it up itself.
    const pid = Number(await readFile(pidFile, "utf8"));
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

void test("missing terminal IPC means uncertain cleanup even when the vendor closed stdio", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-process-"));
  const pidFile = join(cwd, "pid");
  const source = `const fs=require('node:fs');
    fs.closeSync(0);fs.closeSync(1);fs.closeSync(2);
    fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
  const owned = new ManagedProcess(process.execPath, ["-e", source], {
    cwd,
    signal: new AbortController().signal,
    timeoutMs: 3000,
  });
  let pid = 0;
  try {
    for (let i = 0; i < 100; i++) {
      const text = await readFile(pidFile, "utf8").catch(() => "");
      if (text) {
        pid = Number(text);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(pid);
    owned.child.kill("SIGKILL");
    const exit = await owned.exited;
    assert.equal(exit.cleanupUncertain, true);
    assert.match(exit.error ?? "", /supervisor exited unexpectedly/);
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    owned.stop();
  }
});

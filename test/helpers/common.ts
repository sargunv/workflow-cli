import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export function tempDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `workflow-${name}-`));
}

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

export async function fixtureLines(name: string): Promise<string[]> {
  return (await readFile(fixturePath(name), "utf8")).trim().split("\n");
}

/** Installs a synthetic backend from test/helpers as an executable named `as`. */
export async function installFake(
  directory: string,
  helper: "fake-claude" | "fake-acp",
  as: string,
): Promise<void> {
  const path = join(directory, as);
  await copyFile(new URL(`./${helper}.cjs`, import.meta.url), path);
  await chmod(path, 0o755);
}

// Test setup calls git directly; the runtime's supervised capture is much slower.
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export async function gitRepo(ignore = ".workflow/\n"): Promise<string> {
  const dir = await tempDir("git");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.hooksPath", "/dev/null");
  await writeFile(join(dir, ".gitignore"), ignore);
  git(dir, "add", ".gitignore");
  git(dir, "commit", "-qm", "initial");
  return dir;
}

/** Sets environment variables for one test and restores them afterwards. */
export function setEnv(
  t: TestContext,
  values: Record<string, string | undefined>,
): void {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    });
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export async function waitFor<T>(
  check: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  // CI workers may still be cold-loading QuickJS and fixture processes.
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await check();
    if (value !== undefined && value !== false) {
      return value;
    }
    await setTimeout(10);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The OS can reap a killed process slightly after its pipes close.
export function exited(pid: number): Promise<true> {
  return waitFor(
    () => !alive(pid) || undefined,
    `process ${pid} to exit`,
    3000,
  );
}

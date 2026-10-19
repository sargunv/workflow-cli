import { createHash, type Hash } from "node:crypto";
import { constants } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  realpath,
  symlink,
  readdir,
  readlink,
  open,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { SharedPath } from "../config.js";
import { capture } from "../drivers/process.js";
import { isErrno } from "../types.js";
import type { WorktreeRecord } from "../types.js";
import { errorText } from "../types.js";

export class WorktreeSetupError extends Error {
  constructor(
    readonly record: WorktreeRecord,
    cause: unknown,
  ) {
    super(
      `Worktree setup failed: ${errorText(cause)}; preserved ${record.path} (${record.branch})`,
      { cause },
    );
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);

  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

// Refuse type changes and partial reads: an unstable baseline must never make
// edited ignored files look unchanged and eligible for worktree removal.
async function hashFile(
  path: string,
  digest: Hash,
  buffer: Buffer,
): Promise<void> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    if (!before.isFile()) {
      throw new Error(`Ignored worktree file changed type: ${path}`);
    }

    digest.update(String(before.size) + "\n");
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      );

      if (!bytesRead) {
        throw new Error(
          `Ignored worktree file changed during inspection: ${path}`,
        );
      }

      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }

    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(
        `Ignored worktree file changed during inspection: ${path}`,
      );
    }
  } finally {
    await file.close();
  }
}

async function ignoredState(root: string): Promise<string | undefined> {
  const status = await capture(
    "git",
    [
      "status",
      "--porcelain=v1",
      "--ignored=matching",
      "--untracked-files=all",
      "-z",
    ],
    root,
  );

  const paths = status
    .split("\0")
    .filter((entry) => entry.startsWith("!! "))
    .map((entry) => entry.slice(3))
    .sort();
  if (!paths.length) {
    return undefined;
  }

  const digest = createHash("sha256");
  const buffer = Buffer.alloc(65536);
  const visit = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    let kind = "file";
    if (stat.isSymbolicLink()) {
      kind = "link";
    } else if (stat.isDirectory()) {
      kind = "directory";
    }

    digest.update(
      JSON.stringify([relative(root, path), stat.mode & 0o777, kind]) + "\n",
    );
    if (stat.isSymbolicLink()) {
      digest.update(JSON.stringify(await readlink(path)) + "\n");

      return;
    }

    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        await visit(resolve(path, name));
      }

      return;
    }

    if (!stat.isFile()) {
      throw new Error(
        `Cannot safely inspect ignored worktree content: ${path}`,
      );
    }

    await hashFile(path, digest, buffer);
  };

  for (const path of paths) {
    await visit(resolve(root, path));
  }

  return digest.digest("hex");
}

async function validateCopyTree(
  root: string,
  source: string,
  ancestors = new Set<string>(),
): Promise<void> {
  const target = await realpath(source);
  const components = relative(root, target).split(sep);
  if (
    !inside(root, target) ||
    components.includes(".git") ||
    components.includes(".workflow")
  ) {
    throw new Error(
      `Shared path escapes allowed repository content: ${source}`,
    );
  }

  if (ancestors.has(target)) {
    throw new Error(`Shared directory contains a symlink cycle: ${source}`);
  }

  const stat = await lstat(target);
  if (!stat.isDirectory()) {
    return;
  }

  const next = new Set(ancestors);
  next.add(target);
  for (const name of await readdir(target)) {
    await validateCopyTree(root, resolve(target, name), next);
  }
}

async function prepareParent(root: string, destination: string): Promise<void> {
  const components = relative(root, dirname(destination))
    .split(sep)
    .filter(Boolean);
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    try {
      await mkdir(current);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
    }

    if (!inside(root, await realpath(current))) {
      throw new Error(`Shared path ancestor escapes worktree: ${current}`);
    }
  }
}

export async function createWorktree(
  cwd: string,
  runId: string,
  id: number,
  sharedPaths: SharedPath[] = [],
): Promise<WorktreeRecord> {
  const root = await capture("git", ["rev-parse", "--show-toplevel"], cwd);
  const base = await capture("git", ["rev-parse", "HEAD"], root);
  const path = resolve(root, ".workflow", "worktrees", `${runId}-${id}`);
  const branch = `workflow/${runId}-${id}`;
  // Validate every shared path before mutating git.
  for (const shared of sharedPaths) {
    if (
      !shared.path ||
      isAbsolute(shared.path) ||
      shared.path
        .split(/[\\/]/)
        .some(
          (part) => part === ".." || part === ".git" || part === ".workflow",
        )
    ) {
      throw new Error(`Unsafe worktree shared path: ${shared.path}`);
    }

    const source = await realpath(resolve(root, shared.path));
    if (shared.mode === "copy") {
      await validateCopyTree(root, source);
    }

    if (!inside(root, source)) {
      throw new Error(`Shared path escapes the repository: ${shared.path}`);
    }
  }

  await mkdir(dirname(path), { recursive: true });
  const record: WorktreeRecord = { path, branch, base, kept: true };
  const registered = async () =>
    (await capture("git", ["worktree", "list", "--porcelain", "-z"], root))
      .split("\0")
      .includes(`worktree ${path}`);
  if (await registered()) {
    throw new Error(`Target worktree is already registered: ${path}`);
  }

  try {
    await capture(
      "git",
      ["worktree", "add", "--lock", "-b", branch, path, base],
      root,
    );
  } catch (error) {
    // A checkout hook can fail after Git has registered and populated the tree.
    // Claim only a newly registered target, never a pre-existing worktree.
    if (await registered()) {
      throw new WorktreeSetupError(record, error);
    }

    throw error;
  }

  try {
    for (const shared of sharedPaths) {
      const destination = resolve(path, shared.path);
      let exists = false;
      try {
        await lstat(destination);
        exists = true;
      } catch (error) {
        if (!isErrno(error, "ENOENT")) {
          throw error;
        }
      }

      if (exists) {
        throw new Error(
          `Shared path collides with a tracked file: ${shared.path}`,
        );
      }

      // Existing tracked symlinks in ancestors must not redirect writes outside.
      await prepareParent(path, destination);
      if (!inside(path, await realpath(dirname(destination)))) {
        throw new Error(
          `Shared path ancestor escapes worktree: ${shared.path}`,
        );
      }

      if (shared.mode === "copy") {
        await cp(resolve(root, shared.path), destination, {
          recursive: true,
          dereference: true,
          errorOnExist: true,
          force: false,
        });
      } else {
        await symlink(resolve(root, shared.path), destination);
      }
    }

    record.ignoredBaseline = await ignoredState(path);
  } catch (error) {
    throw new WorktreeSetupError(record, error);
  }

  return record;
}

export async function finishWorktree(
  cwd: string,
  record: WorktreeRecord,
): Promise<WorktreeRecord> {
  const head = await capture("git", ["rev-parse", "HEAD"], record.path);
  const branch = await capture(
    "git",
    ["symbolic-ref", "--short", "HEAD"],
    record.path,
  );
  const status = await capture(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    record.path,
  );
  const branchTip = await capture(
    "git",
    ["rev-parse", `refs/heads/${record.branch}`],
    cwd,
  );
  if (
    head !== record.base ||
    branchTip !== record.base ||
    branch !== record.branch ||
    status
  ) {
    return { ...record, kept: true };
  }

  if ((await ignoredState(record.path)) !== record.ignoredBaseline) {
    return { ...record, kept: true };
  }

  await capture("git", ["worktree", "unlock", record.path], cwd);
  await capture("git", ["worktree", "remove", record.path], cwd);
  await capture("git", ["branch", "-d", record.branch], cwd);

  return { ...record, kept: false };
}

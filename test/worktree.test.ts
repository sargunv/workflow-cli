import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  access,
  readFile,
  mkdir,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { capture } from "../src/drivers/process.js";
import {
  createWorktree,
  finishWorktree,
  WorktreeSetupError,
} from "../src/runtime/worktree.js";
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "workflow-git-"));
  await capture("git", ["init", "-q"], dir);
  await capture("git", ["config", "user.email", "test@example.invalid"], dir);
  await capture("git", ["config", "user.name", "Test"], dir);
  await capture("git", ["config", "commit.gpgsign", "false"], dir);
  await capture("git", ["config", "core.hooksPath", "/dev/null"], dir);
  await writeFile(join(dir, ".gitignore"), ".workflow/\n");
  await capture("git", ["add", ".gitignore"], dir);
  await capture("git", ["commit", "-qm", "initial"], dir);
  return dir;
}
void test("unchanged worktrees are removed, committed clean worktrees are preserved", async () => {
  const dir = await repo();
  const clean = await createWorktree(dir, "wf_test", 1);
  assert.equal((await finishWorktree(dir, clean)).kept, false);
  await assert.rejects(access(clean.path));
  const changed = await createWorktree(dir, "wf_test", 2);
  await writeFile(join(changed.path, "change.txt"), "important work");
  await capture("git", ["add", "change.txt"], changed.path);
  await capture("git", ["commit", "-qm", "agent change"], changed.path);
  assert.equal(
    await capture("git", ["status", "--porcelain"], changed.path),
    "",
  );
  assert.equal((await finishWorktree(dir, changed)).kept, true);
  await access(changed.path);
});
void test("worktree shared paths reject traversal and preserve copied local state", async () => {
  const dir = await repo();
  await assert.rejects(
    createWorktree(dir, "wf_test", 1, [{ path: "../secrets", mode: "copy" }]),
    /Unsafe/,
  );
  await writeFile(join(dir, "local.env"), "test=1");
  const isolated = await createWorktree(dir, "wf_test", 2, [
    { path: "local.env", mode: "copy" },
  ]);
  await access(join(isolated.path, "local.env"));
  assert.equal((await finishWorktree(dir, isolated)).kept, true);
});
void test("copy rejects nested external symlinks before creating a worktree", async () => {
  const { mkdir, symlink } = await import("node:fs/promises");
  const dir = await repo();
  const outside = await mkdtemp(join(tmpdir(), "workflow-outside-"));
  await writeFile(join(outside, "secret"), "outside content");
  await mkdir(join(dir, "assets"));
  await symlink(join(outside, "secret"), join(dir, "assets", "secret"));
  await assert.rejects(
    createWorktree(dir, "wf_test", 3, [{ path: "assets", mode: "copy" }]),
    /escapes/,
  );
  const worktrees = await capture(
    "git",
    ["worktree", "list", "--porcelain"],
    dir,
  );
  assert.equal(worktrees.includes("wf_test-3"), false);
});

void test("ignored copied files use a baseline and newly ignored work is preserved", async () => {
  const dir = await repo();
  await writeFile(join(dir, ".gitignore"), ".workflow/\n.env\nlocal-cache/\n");
  await capture("git", ["add", ".gitignore"], dir);
  await capture("git", ["commit", "-qm", "ignore local state"], dir);
  await writeFile(join(dir, ".env"), "ORIGINAL=1\n");
  const copied = await createWorktree(dir, "wf_test", 4, [
    { path: ".env", mode: "copy" },
  ]);
  assert.equal(
    (await finishWorktree(dir, copied)).kept,
    false,
    "unchanged local copy is removable",
  );
  const changed = await createWorktree(dir, "wf_test", 5, [
    { path: ".env", mode: "copy" },
  ]);
  await writeFile(join(changed.path, ".env"), "VALUABLE_CHANGE=1\n");
  assert.equal((await finishWorktree(dir, changed)).kept, true);
  assert.equal(
    await readFile(join(changed.path, ".env"), "utf8"),
    "VALUABLE_CHANGE=1\n",
  );
  assert.equal(await readFile(join(dir, ".env"), "utf8"), "ORIGINAL=1\n");
  const created = await createWorktree(dir, "wf_test", 6);
  await mkdir(join(created.path, "local-cache"));
  await writeFile(
    join(created.path, "local-cache", "result"),
    "valuable ignored output",
  );
  assert.equal((await finishWorktree(dir, created)).kept, true);
});

void test("failed checkout hooks preserve metadata for the worktree Git already created", async () => {
  const dir = await repo();
  const hooks = await mkdtemp(join(tmpdir(), "workflow-hooks-"));
  await writeFile(
    join(hooks, "post-checkout"),
    "#!/bin/sh\nprintf 'fixture checkout failed\\n' >&2\nexit 1\n",
  );
  await chmod(join(hooks, "post-checkout"), 0o755);
  await capture("git", ["config", "core.hooksPath", hooks], dir);
  await assert.rejects(createWorktree(dir, "wf_test", 7), (asyncError) => {
    assert.ok(asyncError instanceof WorktreeSetupError);
    assert.equal(asyncError.record.kept, true);
    assert.match(asyncError.message, /fixture checkout failed/);
    assert.equal(asyncError.record.branch, "workflow/wf_test-7");
    return true;
  });
  await access(join(dir, ".workflow", "worktrees", "wf_test-7", ".git"));
  await assert.rejects(createWorktree(dir, "wf_test", 7), (error) => {
    assert.equal(
      error instanceof WorktreeSetupError,
      false,
      "a retry must not claim an existing artifact as newly created",
    );
    return true;
  });
});

import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  createWorktree,
  finishWorktree,
  WorktreeSetupError,
} from "../src/runtime/worktree.js";
import { git, gitRepo, tempDir } from "./helpers/common.js";

void test("finished worktrees are removed only when they hold nothing of value", async () => {
  const dir = await gitRepo(".workflow/\n.env\nlocal-cache/\n");
  await writeFile(join(dir, ".env"), "ORIGINAL=1\n");
  const env = [{ path: ".env", mode: "copy" as const }];

  const clean = await createWorktree(dir, "wf_test", 1, env);
  assert.equal((await finishWorktree(dir, clean)).kept, false);
  await assert.rejects(access(clean.path));

  const committed = await createWorktree(dir, "wf_test", 2);
  await writeFile(join(committed.path, "change.txt"), "important work");
  git(committed.path, "add", "change.txt");
  git(committed.path, "commit", "-qm", "agent change");
  assert.equal((await finishWorktree(dir, committed)).kept, true);

  const copied = await createWorktree(dir, "wf_test", 3, env);
  await writeFile(join(copied.path, ".env"), "VALUABLE_CHANGE=1\n");
  assert.equal((await finishWorktree(dir, copied)).kept, true);
  assert.equal(await readFile(join(dir, ".env"), "utf8"), "ORIGINAL=1\n");

  const ignored = await createWorktree(dir, "wf_test", 4);
  await mkdir(join(ignored.path, "local-cache"));
  await writeFile(join(ignored.path, "local-cache", "result"), "output");
  assert.equal((await finishWorktree(dir, ignored)).kept, true);
});

void test("shared paths cannot reach outside the repository", async () => {
  const dir = await gitRepo();
  await assert.rejects(
    createWorktree(dir, "wf_test", 1, [{ path: "../secrets", mode: "copy" }]),
    /Unsafe/,
  );
  const outside = await tempDir("outside");
  await writeFile(join(outside, "secret"), "outside content");
  await mkdir(join(dir, "assets"));
  await symlink(join(outside, "secret"), join(dir, "assets", "secret"));
  await assert.rejects(
    createWorktree(dir, "wf_test", 2, [{ path: "assets", mode: "copy" }]),
    /escapes/,
  );
  assert.equal(git(dir, "worktree", "list").includes("wf_test-2"), false);
});

void test("a failed checkout hook keeps the worktree Git already created", async () => {
  const dir = await gitRepo();
  const hooks = await tempDir("hooks");
  await writeFile(
    join(hooks, "post-checkout"),
    "#!/bin/sh\nprintf 'fixture checkout failed\\n' >&2\nexit 1\n",
  );
  await chmod(join(hooks, "post-checkout"), 0o755);
  git(dir, "config", "core.hooksPath", hooks);
  await assert.rejects(createWorktree(dir, "wf_test", 7), (error) => {
    assert.ok(error instanceof WorktreeSetupError);
    assert.equal(error.record.kept, true);
    assert.match(error.message, /fixture checkout failed/);
    return true;
  });
  await access(join(dir, ".workflow", "worktrees", "wf_test-7", ".git"));
  // A retry must not claim the existing worktree as its own to clean up.
  await assert.rejects(
    createWorktree(dir, "wf_test", 7),
    (error) => !(error instanceof WorktreeSetupError),
  );
});

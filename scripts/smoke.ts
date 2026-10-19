// Installs the packed tarball and runs it against the fake Claude CLI, so the
// copied guest and supervisor are exercised from dist rather than src.
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { version } from "../src/version.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "workflow-smoke-"));

function run(command: string, args: string[], cwd: string, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
  return result.stdout;
}

try {
  const packs = join(work, "pack");
  run("pnpm", ["pack", "--pack-destination", packs], root);
  const [tarball] = await readdir(packs);
  if (!tarball) {
    throw new Error("pnpm pack produced no tarball");
  }

  const prefix = join(work, "prefix");
  run(
    "npm",
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--no-audit",
      "--no-fund",
      join(packs, tarball),
    ],
    work,
  );
  const cli = join(prefix, "bin", "workflow-cli");

  const project = join(work, "project");
  const bin = join(project, "bin");
  await mkdir(bin, { recursive: true });
  await copyFile(
    join(root, "test", "helpers", "fake-claude.cjs"),
    join(bin, "claude"),
  );
  await chmod(join(bin, "claude"), 0o755);
  await writeFile(
    join(project, "main.js"),
    "export const meta={name:'smoke',description:'Package smoke test'};\nreturn agent('hello smoke');\n",
  );
  const env = {
    ...process.env,
    PATH: [bin, dirname(process.execPath)].join(delimiter),
    XDG_CONFIG_HOME: join(project, "config"),
  };

  const reported = run(cli, ["--version"], project, env).trim();
  if (reported !== version) {
    throw new Error(`Installed CLI reports ${reported}, expected ${version}`);
  }

  const output = run(cli, ["run", "main.js", "--json"], project, env);
  const report = z
    .object({ result: z.unknown() })
    .parse(JSON.parse(output.trim().split("\n").at(-1) ?? "null"));
  if (report.result !== "hello smoke") {
    throw new Error(`Unexpected result: ${JSON.stringify(report.result)}`);
  }
  console.log(`Smoke passed: ${tarball}`);
} finally {
  await rm(work, { recursive: true, force: true });
}

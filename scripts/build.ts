import { spawnSync } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist");
await rm(output, { recursive: true, force: true });

const compile = spawnSync("tsc", ["-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});
if (compile.error) {
  throw compile.error;
}
if (compile.status !== 0) {
  process.exit(compile.status ?? 1);
}

// These programs execute in different runtimes. Copy the reviewed source itself,
// rather than compiling it into strings or maintaining a second generated copy.
for (const path of ["runtime/guest.js", "drivers/supervisor.cjs"]) {
  const source = join(root, "src", path);
  const syntax = spawnSync(process.execPath, ["--check", source], {
    stdio: "inherit",
  });
  if (syntax.error) {
    throw syntax.error;
  }
  if (syntax.status !== 0) {
    process.exit(syntax.status ?? 1);
  }

  const destination = join(output, path);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
export const notice =
  "Agents run without approval prompts. Use worktree isolation and supported read-only policies; use a container or VM for untrusted repositories.";
export async function firstRunNotice(root: string): Promise<boolean> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await writeFile(join(root, ".permission-notice-v1"), notice + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

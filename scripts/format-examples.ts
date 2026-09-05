import { spawnSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, type Comment } from "acorn";
import { simple } from "acorn-walk";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = join(root, "examples");

function syntax(source: string, comments?: Comment[]) {
  return parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowReturnOutsideFunction: true,
    onComment: comments,
  });
}

// Workflow bodies allow top-level return; ordinary module formatters do not.
// Temporarily wrap only the body, format it normally, then unwrap via the AST.
export function formatWorkflow(source: string): string {
  const header = syntax(source).body[0];
  if (!header || header.type !== "ExportNamedDeclaration") {
    throw new Error("Expected workflow metadata before the script body");
  }
  const wrapped = `${source.slice(0, header.end)}\nasync function workflowBody() {\n${source.slice(header.end)}\n}`;
  const formatted = spawnSync("dprint", ["fmt", "--stdin", "workflow.js"], {
    cwd: root,
    input: wrapped,
    encoding: "utf8",
  });
  if (formatted.error) {
    throw formatted.error;
  }
  if (formatted.status !== 0) {
    throw new Error(formatted.stderr);
  }

  const output = formatted.stdout;
  const comments: Comment[] = [];
  const wrapper = syntax(output, comments).body.at(-1);
  if (
    wrapper?.type !== "FunctionDeclaration" ||
    wrapper.id?.name !== "workflowBody"
  ) {
    throw new Error("Formatter did not preserve the workflow wrapper");
  }
  // Literal contents and block-comment diagrams retain their indentation.
  // Remove the wrapper's two spaces only from code lines.
  const preservedRanges: { start: number; end: number }[] = comments.filter(
    (comment) => comment.type === "Block",
  );
  simple(wrapper.body, {
    TemplateElement(node) {
      preservedRanges.push(node);
    },
    Literal(node) {
      if (typeof node.value === "string") {
        preservedRanges.push(node);
      }
    },
  });
  let offset = wrapper.body.start + 1;
  const body = output.slice(offset, wrapper.body.end - 1);
  const dedented = body
    .split("\n")
    .map((line) => {
      const preserveIndent = preservedRanges.some(
        ({ start, end }) => start <= offset && offset < end,
      );
      offset += line.length + 1;
      return preserveIndent ? line : line.replace(/^ {2}/, "");
    })
    .join("\n");
  return `${output.slice(0, wrapper.start).trimEnd()}\n\n${dedented.trim()}\n`;
}

async function main() {
  const check = process.argv.includes("--check");
  for (const file of (await readdir(directory))
    .filter((file) => file.endsWith(".js"))
    .sort()) {
    const path = join(directory, file);
    const source = await readFile(path, "utf8");
    const formatted = formatWorkflow(source);
    if (source === formatted) {
      continue;
    }
    if (check) {
      process.stderr.write(`Unformatted workflow: examples/${file}\n`);
      process.exitCode = 1;
    } else {
      await writeFile(path, formatted);
      process.stdout.write(`Formatted examples/${file}\n`);
    }
  }
}

if (import.meta.main) {
  await main();
}

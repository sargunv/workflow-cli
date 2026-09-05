import { readFile, stat } from "node:fs/promises";

import { parse } from "acorn";
import type { Expression, SpreadElement } from "acorn";
import { simple } from "acorn-walk";

import { metadata } from "../types.js";
import type { Json, Metadata } from "../types.js";

export interface Script {
  source: string;
  body: string;
  meta: Metadata;
  backends: string[];
  children: Json[];
  profiles: string[];
}

function literal(node: Expression): Json {
  switch (node.type) {
    case "Literal":
      if (
        node.value === null ||
        typeof node.value === "string" ||
        typeof node.value === "boolean"
      ) {
        return node.value;
      }
      if (typeof node.value === "number" && Number.isFinite(node.value)) {
        return node.value;
      }
      break;
    case "UnaryExpression":
      if (
        node.operator === "-" &&
        node.argument.type === "Literal" &&
        typeof node.argument.value === "number"
      ) {
        return -node.argument.value;
      }
      break;
    case "ArrayExpression":
      return node.elements.map((item) => {
        if (!item || item.type === "SpreadElement") {
          throw new Error(
            "meta must contain only literals (no holes or spreads)",
          );
        }

        return literal(item);
      });
    case "ObjectExpression": {
      const result: Record<string, Json> = Object.create(null);
      for (const property of node.properties) {
        if (
          property.type !== "Property" ||
          property.computed ||
          property.method ||
          property.shorthand ||
          property.kind !== "init"
        ) {
          throw new Error("meta must contain only literal properties");
        }

        let key: string | null = null;
        if (property.key.type === "Identifier") {
          key = property.key.name;
        } else if (property.key.type === "Literal") {
          key = String(property.key.value);
        }

        if (key === null || Object.hasOwn(result, key)) {
          throw new Error("Invalid or duplicate meta property");
        }

        result[key] = literal(property.value);
      }

      return result;
    }
  }

  throw new Error(
    "meta must contain only pure literals; expressions, functions, and interpolation are not allowed",
  );
}

function staticChildReference(
  node: Expression | SpreadElement | undefined,
): Json | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }

  if (node?.type !== "ObjectExpression") {
    return undefined;
  }

  try {
    const ref = literal(node);
    if (
      ref &&
      typeof ref === "object" &&
      !Array.isArray(ref) &&
      typeof ref.scriptPath === "string"
    ) {
      return ref;
    }
  } catch {
    // Computed references cannot be preflighted; resolve them at first use.
  }

  return undefined;
}

function staticStringOptions(
  node: Expression | SpreadElement | undefined,
): [string, string][] {
  if (node?.type !== "ObjectExpression") {
    return [];
  }

  const entries: [string, string][] = [];
  for (const property of node.properties) {
    if (
      property.type !== "Property" ||
      property.computed ||
      property.value.type !== "Literal" ||
      typeof property.value.value !== "string"
    ) {
      continue;
    }

    let key: string | undefined;
    if (property.key.type === "Identifier") {
      key = property.key.name;
    } else if (property.key.type === "Literal") {
      key = String(property.key.value);
    }

    if (key !== undefined) {
      entries.push([key, property.value.value]);
    }
  }

  return entries;
}

export function parseScript(source: string): Script {
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowReturnOutsideFunction: true,
  });
  const first = ast.body[0];
  if (
    first?.type !== "ExportNamedDeclaration" ||
    first.declaration?.type !== "VariableDeclaration" ||
    first.declaration.kind !== "const"
  ) {
    throw new Error(
      "Script must begin with export const meta = { name, description }",
    );
  }

  const declaration = first.declaration.declarations[0];
  if (
    first.declaration.declarations.length !== 1 ||
    declaration?.id.type !== "Identifier" ||
    declaration.id.name !== "meta" ||
    !declaration.init
  ) {
    throw new Error("First declaration must be export const meta");
  }

  const meta = metadata.parse(literal(declaration.init));

  for (const statement of ast.body.slice(1)) {
    if (
      statement.type.startsWith("Import") ||
      statement.type.startsWith("Export")
    ) {
      throw new Error(
        "Imports and other exports are unavailable in workflow scripts",
      );
    }
  }

  const backends = new Set<string>();
  const children: Json[] = [];
  const profiles = new Set<string>();

  simple(ast, {
    ImportExpression() {
      throw new Error("Dynamic imports are unavailable in workflow scripts");
    },
    CallExpression(node) {
      if (node.callee.type !== "Identifier") {
        return;
      }

      const name = node.callee.name;
      if (name !== "agent" && name !== "workflow") {
        return;
      }

      if (name === "workflow") {
        const child = staticChildReference(node.arguments[0]);
        if (child !== undefined) {
          children.push(child);
        }
      }

      const options = node.arguments[name === "agent" ? 1 : 2];
      for (const [key, value] of staticStringOptions(options)) {
        if (key === "backend") {
          backends.add(value);
        }

        if (name === "agent" && key === "profile") {
          profiles.add(value);
        }
      }
    },
  });

  // Keep line positions intact for diagnostics while removing the only export.
  const body =
    source.slice(0, first.start) +
    source.slice(first.start, first.end).replace(/[^\n]/g, " ") +
    source.slice(first.end);

  return {
    source,
    body,
    meta,
    backends: [...backends],
    children,
    profiles: [...profiles],
  };
}

export async function readScriptFile(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(
      `Workflow script must be a regular file; use stdin for streams: ${path}`,
    );
  }

  return readFile(path, { encoding: "utf8", signal });
}

import { readFile, stat } from "node:fs/promises";

import { parse } from "acorn";
import type { Expression } from "acorn";
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
      )
        return node.value;
      if (typeof node.value === "number" && Number.isFinite(node.value))
        return node.value;
      break;
    case "UnaryExpression":
      if (
        node.operator === "-" &&
        node.argument.type === "Literal" &&
        typeof node.argument.value === "number"
      )
        return -node.argument.value;
      break;
    case "ArrayExpression":
      return node.elements.map((item) => {
        if (!item || item.type === "SpreadElement")
          throw new Error(
            "meta must contain only literals (no holes or spreads)",
          );
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
        )
          throw new Error("meta must contain only literal properties");
        const key =
          property.key.type === "Identifier"
            ? property.key.name
            : property.key.type === "Literal"
              ? String(property.key.value)
              : null;
        if (key === null || Object.hasOwn(result, key))
          throw new Error("Invalid or duplicate meta property");
        result[key] = literal(property.value);
      }
      return result;
    }
  }
  throw new Error(
    "meta must contain only pure literals; expressions, functions, and interpolation are not allowed",
  );
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
  )
    throw new Error(
      "Script must begin with export const meta = { name, description }",
    );
  const declaration = first.declaration.declarations[0];
  if (
    first.declaration.declarations.length !== 1 ||
    declaration?.id.type !== "Identifier" ||
    declaration.id.name !== "meta" ||
    !declaration.init
  )
    throw new Error("First declaration must be export const meta");
  const meta = metadata.parse(literal(declaration.init));
  for (const statement of ast.body.slice(1)) {
    if (
      statement.type.startsWith("Import") ||
      statement.type.startsWith("Export")
    )
      throw new Error(
        "Imports and other exports are unavailable in workflow scripts",
      );
  }
  const backends = new Set<string>();
  const children: Json[] = [];
  const profiles = new Set<string>();
  simple(ast, {
    ImportExpression() {
      throw new Error("Dynamic imports are unavailable in workflow scripts");
    },
    CallExpression(node) {
      if (node.callee.type !== "Identifier") return;
      const name = node.callee.name;
      if (
        name === "workflow" &&
        node.arguments[0]?.type === "Literal" &&
        typeof node.arguments[0].value === "string"
      )
        children.push(node.arguments[0].value);
      if (
        name === "workflow" &&
        node.arguments[0]?.type === "ObjectExpression"
      ) {
        try {
          const ref = literal(node.arguments[0]);
          if (
            ref &&
            typeof ref === "object" &&
            !Array.isArray(ref) &&
            typeof ref.scriptPath === "string"
          )
            children.push(ref);
        } catch {
          /* computed references resolve at first use */
        }
      }
      const options =
        node.arguments[name === "agent" ? 1 : name === "workflow" ? 2 : -1];
      if (name === "agent" && options?.type === "ObjectExpression")
        for (const prop of options.properties) {
          if (
            prop.type === "Property" &&
            !prop.computed &&
            ((prop.key.type === "Identifier" && prop.key.name === "profile") ||
              (prop.key.type === "Literal" && prop.key.value === "profile")) &&
            prop.value.type === "Literal" &&
            typeof prop.value.value === "string"
          )
            profiles.add(prop.value.value);
        }
      if (options?.type === "ObjectExpression")
        for (const prop of options.properties) {
          if (
            prop.type === "Property" &&
            !prop.computed &&
            ((prop.key.type === "Identifier" && prop.key.name === "backend") ||
              (prop.key.type === "Literal" && prop.key.value === "backend")) &&
            prop.value.type === "Literal" &&
            typeof prop.value.value === "string"
          )
            backends.add(prop.value.value);
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
  if (!info.isFile())
    throw new Error(
      `Workflow script must be a regular file; use stdin for streams: ${path}`,
    );
  return readFile(path, { encoding: "utf8", signal });
}

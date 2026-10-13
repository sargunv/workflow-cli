import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";

import type { Json } from "../types.js";

const ajv = new Ajv({
  strict: false,
  allErrors: true,
  validateFormats: false,
  addUsedSchema: false,
});

function object(value: Json | undefined): Record<string, Json> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

// Traverse schema locations only: const/enum/default/examples contain instance data.
function subschemas(schema: Record<string, Json>): Record<string, Json>[] {
  const nodes: Record<string, Json>[] = [];
  const add = (value: Json | undefined) => {
    const node = object(value);
    if (node) {
      nodes.push(node);
    }
  };

  for (const key of [
    "properties",
    "patternProperties",
    "definitions",
    "$defs",
    "dependencies",
  ]) {
    const map = object(schema[key]);
    if (map) {
      for (const value of Object.values(map)) {
        add(value);
      }
    }
  }

  for (const key of [
    "additionalProperties",
    "additionalItems",
    "contains",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
  ]) {
    add(schema[key]);
  }

  for (const key of ["allOf", "anyOf", "oneOf", "items"]) {
    const value = schema[key];
    if (Array.isArray(value)) {
      value.forEach(add);
    } else {
      add(value);
    }
  }

  return nodes;
}

// A contradiction in an optional property or one alternative does not make the
// root impossible. Only reject constraints proven active for the node's type.
function impossible(value: Json): boolean {
  if (value === false) {
    return true;
  }

  const schema = object(value);
  if (!schema) {
    return false;
  }

  const boundsByType: Record<string, readonly [string, string]> = {
    object: ["minProperties", "maxProperties"],
    array: ["minItems", "maxItems"],
    string: ["minLength", "maxLength"],
    number: ["minimum", "maximum"],
    integer: ["minimum", "maximum"],
  };

  const bounds =
    typeof schema.type === "string" && Object.hasOwn(boundsByType, schema.type)
      ? boundsByType[schema.type]
      : undefined;
  if (bounds) {
    const [min, max] = bounds;
    const lower = schema[min];
    const upper = schema[max];
    if (
      typeof lower === "number" &&
      typeof upper === "number" &&
      lower > upper
    ) {
      return true;
    }
  }

  if (schema.type === "object" && Array.isArray(schema.required)) {
    const properties = object(schema.properties) ?? {};
    for (const key of schema.required) {
      if (
        typeof key === "string" &&
        properties[key] !== undefined &&
        impossible(properties[key])
      ) {
        return true;
      }
    }

    if (
      typeof schema.maxProperties === "number" &&
      new Set(schema.required).size > schema.maxProperties
    ) {
      return true;
    }
  }

  if (Array.isArray(schema.allOf) && schema.allOf.some(impossible)) {
    return true;
  }

  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(schema[key]) && schema[key].every(impossible)) {
      return true;
    }
  }

  return false;
}

export function compileSchema(schema: Record<string, Json>): ValidateFunction {
  if (schema.type !== "object" || !object(schema.properties)) {
    throw new Error("Schema root must have type: object and properties");
  }

  const props = object(schema.properties) ?? {};
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      schema.required.some(
        (key) => typeof key !== "string" || !Object.hasOwn(props, key),
      ))
  ) {
    throw new Error("Schema required must be a subset of properties");
  }

  if (impossible(schema)) {
    throw new Error("Unsatisfiable schema: contradictory active constraints");
  }

  const validate = ajv.compile(schema);
  if (schema.const !== undefined && !validate(schema.const)) {
    throw new Error("Unsatisfiable schema: const fails its constraints");
  }

  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((value) => validate(value))
  ) {
    throw new Error(
      "Unsatisfiable schema: no enum value satisfies constraints",
    );
  }

  return validate;
}

export function schemaError(validate: ValidateFunction): string {
  return ajv.errorsText(validate.errors).slice(0, 4000);
}

export function parseStructured(text: string): Json {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text);

  return JSON.parse(fenced?.[1] ?? text);
}

// Codex and Muse native output accept only strict object schemas.
export function strictNativeCompatible(schema: Record<string, Json>): boolean {
  const visit = (value: Json): boolean => {
    if (Array.isArray(value)) {
      return value.every(visit);
    }

    const node = object(value);
    if (!node) {
      return true;
    }

    if (node.type === "object" || node.properties) {
      const props = object(node.properties);
      if (
        node.additionalProperties !== false ||
        !props ||
        !Array.isArray(node.required) ||
        Object.keys(props).some(
          (key) =>
            !Array.isArray(node.required) || !node.required.includes(key),
        )
      ) {
        return false;
      }
    }

    return subschemas(node).every(visit);
  };

  return visit(schema);
}

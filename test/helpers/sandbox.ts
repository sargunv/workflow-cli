import type { SandboxHost } from "../../src/runtime/sandbox.js";
import { parseScript } from "../../src/runtime/script.js";
import type { Script } from "../../src/runtime/script.js";
import type { Json } from "../../src/types.js";

export function script(body: string): Script {
  return parseScript(
    `export const meta = {name: 'test', description: 'test'};\n${body}`,
  );
}

/** A host whose agents echo their prompt unless overridden. */
export function host(overrides: Partial<SandboxHost> = {}): SandboxHost {
  return {
    validateAgent() {},
    async agent(prompt) {
      return prompt;
    },
    async workflow() {
      return null;
    },
    log() {},
    phase() {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

export function text(prompt: Json): string {
  return typeof prompt === "string" ? prompt : JSON.stringify(prompt);
}

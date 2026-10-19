import type { Detection, DriverRequest } from "../types.js";
import { errorText } from "../types.js";
import { capture, findBinary } from "./process.js";

/** Locates the executable and reads its version; `probe` runs only if both succeed. */
export async function detectBackend(
  executable: string,
  capabilities: Omit<Detection, "available" | "binary" | "version">,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  probe: (binary: string, detection: Detection) => Promise<void>,
): Promise<Detection> {
  const binary = await findBinary(executable);
  const { name, ...rest } = capabilities;
  const detection: Detection = { name, available: !!binary, binary, ...rest };

  if (!binary) {
    detection.notes.push(
      `Install ${executable} and authenticate it before running workflows`,
    );
  } else {
    try {
      detection.version = await capture(
        binary,
        ["--version"],
        cwd,
        timeoutMs,
        signal,
      );
    } catch (error) {
      detection.available = false;
      detection.notes.push(errorText(error));
    }

    if (detection.available) {
      await probe(binary, detection);
    }
  }

  signal.throwIfAborted();

  return detection;
}

export function availableBinary(detection: Detection): string {
  if (!detection.available || !detection.binary) {
    throw new Error(
      `${detection.name} unavailable: ${detection.notes.join("; ")}`,
    );
  }

  return detection.binary;
}

export function composePrompt(request: DriverRequest): string {
  return `${request.systemAppend}\n\nTask:\n${request.prompt}`;
}

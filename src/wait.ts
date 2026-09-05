import { setTimeout } from "node:timers/promises";

import { inspectReport } from "./runtime/control.js";
import type { Report } from "./runtime/store.js";

export async function waitForRun(
  root: string,
  id: string,
  signal: AbortSignal,
  onProgress: (report: Report) => void = () => {},
): Promise<Report> {
  for (;;) {
    signal.throwIfAborted();
    const report = await inspectReport(root, id);
    onProgress(report);
    if (report.status !== "running") {
      return report;
    }

    await setTimeout(250, undefined, { signal });
  }
}

export const meta = {
  name: "multi-modal-sweep",
  description:
    "Search independently using four strategies then deduplicate and refute",
};

if (!args || typeof args.task !== "string" || !args.task.trim()) {
  throw Error(
    "Pass --args with a nonempty task string; include absolute repository paths.",
  );
}

const readOnly = { toolPolicy: "read-only" };

const findingsSchema = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, claim: { type: "string" } },
        required: ["id", "claim"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
};

const voteSchema = {
  type: "object",
  properties: { valid: { type: "boolean" }, reason: { type: "string" } },
  required: ["valid", "reason"],
  additionalProperties: false,
};

const strategies = ["git history", "call sites", "invariants", "test gaps"];

const batches = await pipeline(strategies, (strategy) =>
  agent(
    `Task: ${args.task}. Search using ${strategy}. Return concrete findings with stable location-plus-cause IDs. ` +
      "Work independently; no other searcher conclusions are available.",
    { ...readOnly, phase: "Search", label: strategy, schema: findingsSchema },
  ),
);

// Cross-searcher deduplication requires the whole search set.
const seen = new Set();
const fresh = [];
let duplicates = 0;
let failed = 0;

for (const batch of batches) {
  if (batch === null) {
    failed++;
    continue;
  }

  for (const item of batch.findings) {
    if (seen.has(item.id)) {
      duplicates++;
      continue;
    }

    seen.add(item.id);
    fresh.push(item);
  }
}

log(
  `Search: ${failed} failed strategies, ${duplicates} duplicate findings dropped, ${fresh.length} unique findings`,
);

if (!fresh.length) {
  log(
    "No unique findings; failed strategies still represent missing coverage",
  );
}

const findings = await pipeline(fresh, async (item) => {
  const verdict = await agent(
    `Task: ${args.task}. Try to refute ${JSON.stringify(item)}. Return evidence.`,
    { ...readOnly, phase: "Verify", label: item.id, schema: voteSchema },
  );
  if (verdict === null) {
    log(`Verification failed for ${item.id}; returning unresolved finding`);
  } else if (!verdict.valid) {
    log(`Rejected ${item.id}; returning counterevidence`);
  }

  return { item, verdict };
});

return { failedStrategies: failed, duplicates, findings };

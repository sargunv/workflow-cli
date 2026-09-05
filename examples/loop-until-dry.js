export const meta = {
  name: "loop-until-dry",
  description:
    "Search and refute until two complete rounds discover no new identities",
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

const seen = new Set();
const evaluated = [];
let dry = 0;
let round = 0;
let failed = false;
const maxRounds = args.maxRounds ?? 8;

if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 100) {
  throw Error("maxRounds must be an integer from 1 to 100.");
}

while (dry < 2 && round < maxRounds) {
  round++;
  const batch = await agent(
    `Find concrete issues for ${args.task}. Use stable location-plus-cause IDs. ` +
      `Exclude all previously seen IDs, including rejected claims: ${JSON.stringify([...seen])}.`,
    {
      ...readOnly,
      phase: `Round ${round}`,
      label: "Find",
      schema: findingsSchema,
    },
  );

  if (batch === null) {
    log("Finder failed; stopping without claiming convergence");
    failed = true;
    break;
  }

  const fresh = [];
  for (const item of batch.findings) {
    if (!seen.has(item.id)) {
      fresh.push(item);
    }

    seen.add(item.id); // Includes rejected findings and duplicates within this round.
  }

  log(
    `Round ${round}: ${fresh.length} new, ${batch.findings.length - fresh.length} duplicates dropped`,
  );
  dry = fresh.length ? 0 : dry + 1;
  const verified = await pipeline(fresh, async (item) => {
    const verdict = await agent(
      `Task: ${args.task}. Try to refute ${JSON.stringify(item)}. Cite evidence.`,
      {
        ...readOnly,
        phase: `Round ${round}`,
        label: `Refute ${item.id}`,
        schema: voteSchema,
      },
    );

    if (verdict === null) {
      log(`Verification failed for ${item.id}; retained as unresolved`);
    } else if (!verdict.valid) {
      log(`Rejected ${item.id}; its identity remains in the seen set`);
    }

    return { item, verdict };
  });

  evaluated.push(...verified);
}

if (dry < 2 && !failed) {
  log(`Round limit ${maxRounds} reached before convergence`);
}

return { converged: dry >= 2, rounds: round, seen: [...seen], evaluated };

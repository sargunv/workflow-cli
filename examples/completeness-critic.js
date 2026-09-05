export const meta = {
  name: "completeness-critic",
  description:
    "Challenge a proposed result against its requirements and evidence",
};

if (!args || typeof args.task !== "string" || !args.task.trim()) {
  throw Error(
    "Pass --args with a nonempty task string; include absolute repository paths.",
  );
}

const readOnly = { toolPolicy: "read-only" };

if (
  !Array.isArray(args.requirements) ||
  !Object.hasOwn(args, "evidence") ||
  !Object.hasOwn(args, "result")
) {
  throw Error(
    "Supply requirements array, evidence, and result alongside task.",
  );
}

const schema = {
  type: "object",
  properties: {
    missing: { type: "array", items: { type: "string" } },
    unsupported: { type: "array", items: { type: "string" } },
    explanation: { type: "string" },
  },
  required: ["missing", "unsupported", "explanation"],
  additionalProperties: false,
};

const critic = await agent(
  `Task: ${args.task}. Requirements: ${JSON.stringify(args.requirements)}. ` +
    `Evidence: ${JSON.stringify(args.evidence)}. Proposed result: ${JSON.stringify(args.result)}. ` +
    "Identify every missing requirement and unsupported claim. Inspect evidence where available. " +
    "Plans and compilation alone are not proof of completed runtime behavior. Do not edit.",
  { ...readOnly, phase: "Completeness", label: "Adversarial critic", schema },
);

if (critic === null) {
  log("Completeness critic failed; completion is unverified");
} else {
  log(
    `Critic found ${critic.missing.length} missing requirements and ${critic.unsupported.length} unsupported claims`,
  );
}

return { proposedResult: args.result, critic };

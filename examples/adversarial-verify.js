export const meta = {
  name: "adversarial-verify",
  description:
    "Independently refute each supplied finding and retain evidence and dissent",
};

if (!args || typeof args.task !== "string" || !args.task.trim()) {
  throw Error(
    "Pass --args with a nonempty task string; include absolute repository paths.",
  );
}

const readOnly = { toolPolicy: "read-only" };

const voteSchema = {
  type: "object",
  properties: { valid: { type: "boolean" }, reason: { type: "string" } },
  required: ["valid", "reason"],
  additionalProperties: false,
};

if (!Array.isArray(args.findings)) {
  throw Error("args.findings must be an array of claims.");
}

return pipeline(args.findings, async (finding, _, index) => {
  const votes = await parallel(
    [1, 2, 3].map(
      (refuter) => () =>
        agent(
          `Independently try to refute this claim. Task: ${args.task}. Claim: ${JSON.stringify(finding)}. ` +
            "Inspect evidence; valid means the claim survived your attempted refutation. Return concrete evidence or counterevidence.",
          {
            ...readOnly,
            phase: "Refute",
            label: `Finding ${index + 1}, refuter ${refuter}`,
            schema: voteSchema,
          },
        ),
    ),
  );

  const failed = votes.filter((vote) => vote === null).length;
  const positive = votes.filter((vote) => vote !== null && vote.valid).length;
  if (failed) {
    log(
      `Finding ${index + 1}: ${failed} refuters failed; they are not positive votes`,
    );
  }

  if (positive < 2) {
    log(`Finding ${index + 1}: rejected with ${positive}/3 positive votes`);
  }

  return { finding, accepted: positive >= 2, positive, votes };
});

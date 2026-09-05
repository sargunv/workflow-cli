export const meta = {
  name: "judge-panel",
  description:
    "Generate independent attempts and select by a shared panel rubric",
};

if (!args || typeof args.task !== "string" || !args.task.trim()) {
  throw Error(
    "Pass --args with a nonempty task string; include absolute repository paths.",
  );
}

const readOnly = { toolPolicy: "read-only" };

const angles = [
  "simplest design",
  "failure cases first",
  "compatibility first",
];

const scoreSchema = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 0, maximum: 10 },
    reason: { type: "string" },
  },
  required: ["score", "reason"],
  additionalProperties: false,
};

const rubric =
  "Score 0-10: correctness 0-5, evidence 0-3, clarity 0-2. Explain deductions.";

function proposeAttempt(angle) {
  return agent(
    `Task: ${args.task}. Propose a solution from this angle: ${angle}. Inspect evidence; do not edit.`,
    { ...readOnly, phase: "Attempt", label: angle },
  );
}

function judgeAttempt(attempt, angle, judge) {
  return agent(
    `Task: ${args.task}. Candidate: ${attempt}. Independently judge it. ${rubric}`,
    {
      ...readOnly,
      phase: "Judge",
      label: `${angle}, judge ${judge}`,
      schema: scoreSchema,
    },
  );
}

async function scoreCandidate(attempt, angle, index) {
  if (attempt === null) {
    log(`Attempt ${angle} failed; excluded from judging`);

    return null;
  }

  const judges = [1, 2].map(
    (judge) => () => judgeAttempt(attempt, angle, judge),
  );
  const scores = await parallel(judges);
  if (scores.some((score) => score === null)) {
    log(
      `Candidate ${angle} has an incomplete panel; excluded from selection`,
    );

    return { index, angle, attempt, scores, total: null };
  }

  return {
    index,
    angle,
    attempt,
    scores,
    total: scores.reduce((sum, item) => sum + item.score, 0),
  };
}

const candidates = await pipeline(angles, proposeAttempt, scoreCandidate);

// All scores are required to compare candidates fairly.
const eligible = candidates.filter(
  (candidate) => candidate !== null && candidate.total !== null,
);

eligible.sort((a, b) => b.total - a.total || a.index - b.index);

if (!eligible.length) {
  log("No fully judged candidate; no winner selected");

  return { candidates, winner: null, synthesis: null };
}

const winner = eligible[0];

const tied = eligible.filter(
  (candidate) => candidate.total === winner.total,
).length;

if (tied > 1) {
  log(
    `${tied} candidates tied; selecting earliest input angle deterministically`,
  );
}

const synthesis = await agent(
  `Task: ${args.task}. Winning candidate and evidence: ${JSON.stringify(winner)}. ` +
    "Produce the final proposal, preserving limitations. Selection score does not establish correctness.",
  { ...readOnly, phase: "Synthesize", label: "Winning proposal" },
);

if (synthesis === null) {
  log("Final synthesis failed; returning the scored candidates");
}

return { candidates, winner, synthesis };

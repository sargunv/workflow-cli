export const meta = {
  name: "no-silent-caps",
  description:
    "Bound a review queue while reporting every omitted and failed item",
};

if (!args || typeof args.task !== "string" || !args.task.trim()) {
  throw Error(
    "Pass --args with a nonempty task string; include absolute repository paths.",
  );
}
const readOnly = { toolPolicy: "read-only" };
if (
  !Array.isArray(args.items) ||
  args.items.some((item) => typeof item !== "string")
) {
  throw Error("items must be an array of strings.");
}
const limit = args.limit ?? 12;
if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
  throw Error("limit must be an integer from 1 to 100.");
}
const unique = [...new Set(args.items)];
log(
  `Deduplication dropped ${args.items.length - unique.length} repeated items`,
);
const selected = unique.slice(0, limit);
const omitted = unique.slice(limit);
log(
  `Explicit limit ${limit}: reviewing ${selected.length}, deferring ${omitted.length} items in input order`,
);
const results = await pipeline(selected, async (item) => {
  const result = await agent(
    `Task: ${args.task}. Review this item only: ${item}. Cite evidence; do not edit.`,
    { ...readOnly, phase: "Review", label: item },
  );
  if (result === null) {
    log(`Failed review for ${item}; retained as unresolved`);
  }
  return { item, result };
});
return {
  results,
  omitted,
  duplicateCount: args.items.length - unique.length,
};

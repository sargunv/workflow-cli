export const meta = {
  name: 'perspective-diverse-verify',
  description: 'Review a claim through four independent lenses before synthesis',
};
if (!args || typeof args.task !== 'string' || !args.task.trim()) {
  throw Error('Pass --args with a nonempty task string; include absolute repository paths.');
}
const readOnly = { toolPolicy: 'read-only' };
const voteSchema = {
  type: 'object', properties: { valid: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['valid', 'reason'], additionalProperties: false,
};
if (typeof args.claim !== 'string') throw Error('args.claim must be a string.');
const lenses = ['correctness', 'security', 'performance', 'reproduction'];
const reviews = await pipeline(lenses, lens => agent(
  `Task: ${args.task}. Independently refute claim: ${args.claim}. Your lens is ${lens}. ` +
  'Inspect concrete evidence. Do not infer what other reviewers believe.',
  { ...readOnly, phase: 'Independent review', label: lens, schema: voteSchema },
));
const failed = reviews.filter(review => review === null).length;
if (failed) log(`${failed} lenses failed; synthesis must report missing coverage`);
// This barrier is necessary: synthesis compares all four reviews.
const synthesis = await agent(
  `Task: ${args.task}. Claim: ${args.claim}. Lenses: ${JSON.stringify(lenses)}. ` +
  `Reviews in the same order: ${JSON.stringify(reviews)}. Reconcile evidence and dissent; ` +
  'report missing lenses explicitly. A vote is not proof.',
  { ...readOnly, phase: 'Synthesize', label: 'Evidence synthesis' },
);
if (synthesis === null) log('Synthesis failed; returning the independent evidence');
return { lenses, reviews, synthesis };

export const meta = {
  name: 'loop-until-budget',
  description: 'Scale review rounds to the available budget with a finite fallback',
};
if (!args || typeof args.task !== 'string' || !args.task.trim()) {
  throw Error('Pass --args with a nonempty task string; include absolute repository paths.');
}
const readOnly = { toolPolicy: 'read-only' };
const maxRounds = args.maxRounds ?? 3;
const reserve = args.reserveTokens ?? 2000;
if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 100) throw Error('maxRounds must be an integer from 1 to 100.');
if (!Number.isFinite(reserve) || reserve <= 0) throw Error('reserveTokens must be positive.');
if (budget.total === null) log(`Token ceiling is disabled; using explicit ${maxRounds}-round fallback`);
const rounds = [];
let stopReason = 'round limit';
for (let round = 1; round <= maxRounds; round++) {
  if (budget.total !== null && budget.remaining() < reserve) {
    stopReason = 'budget reserve';
    log(`Stopping before round ${round}: remaining budget below ${reserve}-token reserve`);
    break;
  }
  const result = await agent(
    `Task: ${args.task}. Review one additional weakness not addressed by these prior rounds: ${JSON.stringify(rounds)}. ` +
    'Inspect evidence; distinguish findings from uncertainty.',
    { ...readOnly, phase: 'Deepen', label: `Round ${round}` },
  );
  if (result === null) { log(`Round ${round} failed; ending without claiming complete coverage`); stopReason = 'failed round'; break; }
  rounds.push(result);
}
if (stopReason === 'round limit') log(`Stopped at explicit ${maxRounds}-round limit; this is not a completeness claim`);
return { stopReason, rounds };

# Reference consultation

Source: Claude CLI 2.1.261, model `claude-opus-5`, 2026-09-05. The response
below describes tool documentation available to that session; it is not
implementation-source evidence.

I loaded the `workflow-authoring` skill and read `VISION.md`. Below is what the
tool description and that skill actually say, separated from what I'm inferring.
Caveat up front: **my only sources are prompt-level documentation** — the tool
description and the skill text. I have no visibility into the implementation, so
I can't answer VISION.md's open question at line 324 (VM context vs. worker vs.
subprocess). Anything about mechanism below is inference.

## Invocation and resolution

**Documented:** inputs are `script` (inline), `scriptPath`, `name`, `args`,
`resumeFromRunId` (pattern `^wf_[a-z0-9-]{6,}$`). `title`/`description` tool
inputs are explicitly ignored — they come from `meta`. `scriptPath` takes
precedence over `script`, which takes precedence over `name`. Saved workflows
are "built-in or from `.claude/workflows/`" and a `name` "resolves to a
self-contained script." Returns immediately with a task ID; a notification
arrives on completion; the result carries `runId`, transcript dir, and the
persisted script path.

Two things VISION.md doesn't capture: there are **built-in** saved workflows,
not just `.claude/workflows/`; and the word **self-contained** in the `name`
resolution description is the only hint about module imports.

## Sandbox constraints

**Documented:** plain JavaScript, not TypeScript — annotations, interfaces,
generics fail to parse. Body runs in an async context (top-level `await`), and
top-level `return` is the result (shown by example, never stated). Standard
built-ins available _except_ `Date.now()`, `Math.random()`, and **argless** `new
Date()`, which throw. Rationale given verbatim: "they would break resume." No
filesystem or Node.js API access. `meta` is statically parsed as a pure literal
_before_ anything runs, because it feeds the permission dialog.

**Note the precision of "argless":** `new Date('2026-01-01')` is not banned. The
ban targets entropy/clock sources, not the `Date` class. Your CLI should
replicate that distinction exactly.

**Not documented / unknown:** `crypto.getRandomValues`, `performance.now()`,
`process.*`, `fetch`, `setTimeout`, `import`/`require`. Whether the throws are
catchable. Whether the ban is enforced by shadowing, by parse-time rejection, or
by a real isolate.

**My inference:** network and timers are absent — "no Node.js API access" plus
the determinism rationale covers them, and `fetch` would be as replay-breaking
as `Date.now()`. "Self-contained script" suggests no import graph. Confidence:
moderate. VISION.md line 324's guess that global shadowing in a fresh module
scope suffices is consistent with everything documented, but nothing in my
context confirms it.

## Child workflow resolution

**Documented:** `workflow(nameOrRef, args?)`. A string resolves against the same
registry as the tool's `name` input; `{scriptPath}` runs a file _"you Wrote
earlier"_ — so `Write`-then-`workflow()` is the sanctioned path for children,
even though the parent is told never to Write its script first. The child
**shares the parent's concurrency cap, agent counter, abort signal, and token
budget**. Its agents render under a `▸ name` group. `args` becomes the child's
`args` global. **Nesting is one level only — `workflow()` inside a child
throws.** It throws on unknown name, unreadable `scriptPath`, or child syntax
error; the guidance says catch to handle gracefully.

**Consequence worth spelling out in your spec:** because the agent counter is
shared, the 1000-agent cap and the `min(16, cpus-2)` concurrency cap are **per
top-level run, not per workflow**. VISION.md lines 77 and 57 say "per workflow,"
which is only true for a childless run.

**Not documented:** whether child agents land in the parent's `journal.jsonl`
(critical for resume across the boundary); whether a changed child script file
invalidates the parent's cached prefix; whether the child needs its own `meta`;
how child `phase()` titles interact with parent phases beyond the `▸` grouping.
**My inference:** children journal into the shared run and replay normally,
since they share the counter — but a `{scriptPath}` child whose file changed
between runs is a real cache-coherence hole the reference likely doesn't handle,
and your CLI should decide it deliberately.

## Budget and resume semantics

This is the sharpest divergence from VISION.md, and the most consequential for a
standalone CLI.

**Documented:** `budget.total` comes from "the turn's token target from the
user's `+500k`-style directive" — null if unset. `spent()` returns **output
tokens spent this turn across the main loop and all workflows — the pool is
shared, not per-workflow**. `remaining()` is `max(0, total - spent())`, or
`Infinity` if no total. It is a **hard ceiling: once `spent()` reaches `total`,
further `agent()` calls throw.** Resume is **same-session only**, and the tool
description says to **stop the prior run with `TaskStop` before resuming**.

**VISION.md line 56 is wrong on this point.** It calls budget an "output-token
ceiling for the run." It's a ceiling for the _turn_, sourced from a user
directive, shared with the main conversation loop. Neither "turn" nor "main
loop" exists in a standalone CLI, so redefining it as per-run isn't an omission
you can leave implicit — it's a deviation that changes what `loop-until-budget`
scripts do, and belongs in `DECISIONS.md`.

**The interaction the reference never addresses — my inference, but forced by
two documented rules:** cached `agent()` calls on resume spend no tokens, so
they can't plausibly increment `spent()`. Combined with budget being
turn-scoped, a resumed `loop-until-budget` script sees a _different_ `total`
(whatever this turn's directive is, possibly null) and a `spent()` near zero
through the entire cached prefix. So the loop that originally terminated at 500k
keeps iterating past the prefix and runs live agents. Replay is not faithful for
any script that branches on budget.

More broadly: **`budget` is an unacknowledged escape hatch from the determinism
invariant.** `Math.random()` is banned because it makes a script run differently
twice; `budget.spent()` does exactly that and is offered as a first-class
primitive with a documented loop pattern built on it. If determinism is
load-bearing for you (VISION.md line 335), you need an explicit answer here —
journal the budget readings and replay them, or accept and document that
budget-branching scripts don't resume faithfully.

## Schema rejection

**Documented, and it's two distinct layers:**

1. **Author-side, at call time.** Root must be `{type: 'object', properties:
   {...}}`, and `required ⊆ properties`. "Unsatisfiable ones **throw at
   `agent()`**" — synchronous, before any subagent spawns. This is a script
   error, not a null.
2. **Model-side, at tool-call time.** The subagent is forced to call a
   `StructuredOutput` tool whose input schema is the caller's schema.
   "Validation happens at the tool-call layer so the model retries on mismatch."
   The script never parses anything; a mismatch is an error message the _model_
   sees and corrects.

**Not documented:** the retry count at layer 2; what happens when a model ends
its turn without ever calling `StructuredOutput`; which JSON Schema
dialect/keywords are supported (`$ref`, `oneOf`, `additionalProperties`); what
"unsatisfiable" covers beyond the two stated root rules. **My inference:**
turn-ends-without-call collapses into the null bucket. VISION.md line 231
asserts that prompted-backend retry exhaustion → null "matching the reference's
failure contract" — that's a reasonable extension, but the reference's null
contract is documented only for skip and terminal API errors. Label it as your
choice, not parity.

## Retries, skip, and cancel

**Documented:** `agent()` returns `null` if **the user skips the agent mid-run**
or **the subagent dies on a terminal API error after retries**. Retries exist,
are internal, and their count is unspecified. Skip implies a per-agent UI
affordance in the live progress tree. Cancel is the shared abort signal,
reachable via `TaskStop`; stop-edit-resume is the documented iteration loop.

**The three-way failure taxonomy, assembled from scattered statements:**

- **→ `null`:** user skip; terminal API error after retries.
- **→ throw:** budget exceeded; unsatisfiable schema; >4096 items in one
  `parallel`/`pipeline` call ("an explicit error, not a silent truncation");
  `workflow()` with unknown name, unreadable path, child syntax error, or double
  nesting.
- **→ neither:** `parallel()` "never rejects" — a throwing thunk becomes `null`
  in the array. A throwing `pipeline` stage "drops that item to `null` and skips
  its remaining stages."

**The composition trap, and it's a real one:** budget exhaustion _throws inside_
`agent()`. Inside `parallel`/`pipeline` — where budget loops actually live —
that throw is silently converted to `null`. So a budget-exhausted fan-out is
indistinguishable from a fan-out of API failures, and `.filter(Boolean)` erases
both. This follows directly from two documented rules, but the reference never
connects them. It contradicts your "fail loud, degrade explicitly" principle,
and your journal needs a distinguishable reason code per null.

## Smaller corrections to VISION.md

- `meta.phases` entries take **`detail`** as well as `title` and `model`; line
  34 omits `detail`.
- Resume is **same-session only**, and the documented procedure is `TaskStop`
  first. Line 84 mentions neither.
- `phase()` is documented as **mutable global state with races** inside
  `pipeline`/`parallel` — that's why `opts.phase` is preferred there. Worth
  recording as the reason, not just the recommendation.
- Worktree cost is quoted concretely: **~200-500ms setup plus disk, per agent**.
- MCP caveat: **interactively-authenticated servers may be absent in
  headless/cron runs** — visible in this very session, where the claude.ai
  connectors are unauthenticated.
- Two behaviors are **prompt-layer policy, not runtime enforcement**: the opt-in
  gate, and a per-session workflow size guideline (this session's is "medium —
  under 15 agents," set via `/config`). Neither is a cap the runtime enforces.
  If you want either in the CLI, they're config plus skill text, not runtime.

## Follow-up consultation: logging, correction, and cached artifacts

Model: `claude-opus-5`, 2026-09-05. Prompt-level documentation was consulted; no
live Workflow probes were run.

Consulted the Workflow tool description and the `workflow-authoring` skill text.
All three answers are underspecified in the reference — here's exactly what's
documented vs. what's inference.

## 1. `log(message)` — string only?

**Documented:** The signature is given twice, identically:

- Tool description: "`log()`" listed among script body hooks.
- Skill: `log(message: string): void — emit a progress message to the user
  (shown as a narrator line above the progress tree)`.

That's the whole contract. The type annotation says `string`, and the described
rendering ("a narrator line") is textual.

**Not documented:** Any statement about non-string arguments — no mention of
coercion, `JSON.stringify` of objects, rejection, multi-arg variadic form, or
truncation. The one usage example is a template literal
(``log(`${bugs.length}/10 found`)``), which produces a string.

**Inference only:** A JS host implementing `log` almost certainly coerces via
string concatenation or `util.inspect`, so passing a number or object probably
"works." That is a guess about implementation, not a documented promise. For
parity purposes the safe reading is: the reference specifies string, and
non-string behavior is unspecified — a conforming implementation could coerce or
throw.

## 2. Structured-output retry — session preserved or respawned?

**Documented:** One sentence, in the skill: "For structured output, use the
schema option — validation happens at the tool-call layer so the model retries
on mismatch." Plus: "the subagent is forced to call a StructuredOutput tool and
agent() returns the validated object." The tool description adds nothing beyond
`schema` returning a validated object.

**Not documented:** Whether the retry reuses the subagent's existing
session/context or starts a fresh one; how many retries; what happens when
retries are exhausted with a schema error specifically.

**Inference:** "validation happens at the tool-call layer" strongly implies an
in-session retry — the tool call is rejected and the model is asked again within
the same conversation, since a respawn would not be described as tool-call-layer
validation. Related but separate documented fact: `agent()` "returns null if the
user skips the agent mid-run or the subagent dies on a terminal API error
**after retries**" — this establishes that retries exist and that exhaustion
yields `null`, but the phrase covers API errors, not schema mismatch. So:
in-session retry is a well-supported inference, not a stated guarantee.

## 3. Cached worktree metadata / transcripts on resume

**Documented (transcripts): yes, explicitly.** The Resume section promises
artifacts survive and names them:

- `Workflow({scriptPath, resumeFromRunId})` — "the longest unchanged prefix of
  `agent()` calls returns cached results instantly."
- "Read `<transcriptDir>/journal.jsonl` — it records each agent's actual return
  value; do not assume cached results are non-empty."
- Fallback: "Read `agent-<id>.jsonl` files in the transcript directory and
  hand-author a continuation script."
- Scope limit: resume is "Same-session only" (tool description), and the prior
  run should be stopped first (`TaskStop`).

**Documented (worktrees): no.** Worktrees appear only under `opts.isolation:
'worktree'` — "runs the agent in a fresh git worktree — EXPENSIVE (~200-500ms
setup + disk per agent) … the worktree is auto-removed if unchanged." Nothing
states whether a worktree, its path, or its metadata is retained, reattached, or
recreated for a cached agent call on resume.

**Inference:** Since a cached `agent()` call returns its recorded result without
re-running, the worktree presumably is not recreated — and an unchanged one was
already auto-removed. Whether a _changed_ worktree from the original run remains
reachable on resume is genuinely unspecified. That's a real parity gap worth
deciding explicitly rather than reverse-engineering.

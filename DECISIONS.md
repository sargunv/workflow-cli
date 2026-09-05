# Decisions

## Runtime: Node and an isolated QuickJS VM

The vision proposes Bun and asks whether a shadowing preamble is sufficient.
Claude Opus 5 was consulted through the CLI on 2026-09-05. Its tool description
and authoring skill specify observable sandbox behavior but do not expose the
implementation mechanism. We use strict TypeScript on pinned Node, with QuickJS
compiled to WebAssembly for script execution. Only JSON crosses the host bridge;
there is no module loader or host filesystem, process, timer, or network
binding. QuickJS memory, stack, and instruction limits bound runaway scripts.

A Node `vm` context with host functions was considered but does not give the
same separation. See [Node's VM documentation](https://nodejs.org/api/vm.html)
and [QuickJS runtime controls](https://github.com/justjake/quickjs-emscripten).
Revisit if another runtime provides equal isolation with simpler packaging. A
standalone native executable is not a vision requirement; npm installation uses
Node 24 or later.

## Replay records deliveries as well as invocations

The vision promises no-barrier pipelines and unchanged-prefix replay. Resolving
all cached calls in invocation order changes subsequent prompts when agents
originally finished out of order. `replay.jsonl` records starts and deliveries;
`journal.jsonl` holds user-facing agent results. Replay follows the prior
delivery order. First mismatch irreversibly switches the suffix to live
execution. An edited branch that removes a pending invocation must not deadlock
replay.

Imposing a stage barrier was rejected because it changes pipeline semantics.
Tests must continue to prove reversed-completion full cache hits. Resume cannot
guarantee exactly-once external side effects after a crash between an agent's
edits and journal persistence.

Root cancellation journals each outcome but leaves unfinished invocations
without replay completion events. A stopped run therefore resumes its completed
prefix and reruns the interrupted suffix. An intentional per-agent skip is a
completed user choice and stays cached as null. Ordinary terminal failures,
including timeouts and exhausted schema corrections, also stay cached, as the
reference warns that cached results need not be nonempty. Automatically retrying
all nulls was rejected because it erases skips and repeats completed failures;
edit the affected prompt/options or start a fresh run when retrying those is
intended.

## Keep original schema semantics

BACKENDS.md suggests adding all properties to `required` and setting
`additionalProperties: false` for Codex. That changes the caller's schema. Codex
uses native output only when the supplied schema already meets those structural
requirements; otherwise it uses prompted output with local validation. Every
backend's output is validated against the original schema without coercion,
default injection, or removal of extra fields.

Schemas use JSON Schema draft-07 with local references only. Root object and
required-subset rules and proven active contradictions are rejected at call
time. Optional impossible branches, irrelevant type constraints and
instance/annotation data do not make the whole schema impossible. Full
satisfiability of arbitrary JSON Schema is not claimed; the reference does not
specify a solver. Extend contradiction detection as concrete cases arise.

Schema correction never resends the original task. Native ACP retains one
session and sends only validation feedback and the schema. CLI drivers use a
fresh formatting turn containing the prior result, validation error and schema,
with read-only restrictions and without the task or profile preamble. Prior
output is not truncated. CLI resume flags were rejected because they introduce
persistent vendor sessions and unverified resume semantics; reconsider if a
probed multi-turn CLI transport provides a simpler contract.

ACP cannot enforce read-only corrections. Its instructions forbid task tools,
and any correction tool calls are logged with a warning. Formatting cannot
recover facts missing from the original output; bounded failure returns null
instead of repeating edits. Native output is still validated locally against the
original schema. Correction modes appear in info and transcripts.

## Deferred budget

The vision explicitly defers a hard ceiling. `budget.total` is null,
`budget.spent()` is zero, and `budget.remaining()` is Infinity. Actual available
usage is still reported. Claude's reference budget is shared with the launching
conversation turn; a standalone CLI has no such scope. A future enabled budget
requires reliable accounting and recorded budget observations for replay.

## Native ACP means prompted output

OpenCode, Kimi, and Qwen use their native ACP servers, one process per leaf.
Qwen's CLI-native schema facility is absent over ACP. One process per agent
costs startup time but bounds crash and cancellation effects. The ACP client
acknowledges permission requests without interactive prompts. It advertises no
client filesystem or terminal service. ACP tool policies are explicitly
unsupported; requested restrictions fail rather than disappear.

Live follow-up is recorded in `docs/BACKEND-VERIFICATION.md`. ACP sessions
provide model-dependent settings that side-effect-free CLI catalogs omit, so
discovery opens an empty vendor session without sending a model prompt. The
alternative is stale capability inference from separate CLI/config formats.
Revisit when native ACP exposes equivalent session-free discovery. Vendors may
retain empty sessions. Qwen's CLI read-only and limit flags are not claimed over
ACP; runtime deadlines remain available, and unverified tool restrictions fail
closed. Kimi/Qwen use their advertised session YOLO setting where available.

Default model markers are shown only when observed. Claude and Codex do not
expose the configured selection through their catalogs, so omission delegates to
vendor configuration and info says the default is unreported. Choosing a static
default would override the user's backend configuration. Revisit when a vendor
query can report the effective value without making a model call.

## Child source selection and saved artifacts

Literal string and object child references are resolved and loaded before leaf
work. Computed references resolve at first use, which supports files generated
by an earlier agent. Resolution and source stay fixed within a run. Child
archives include original paths and content hashes. A new run or resume prefers
an existing current source; only an absent original falls back to the previous
run's verified archive, with a warning. This allows a cached generator to retain
its child without replaying its edits. Missing or corrupt archived source fails
explicitly. Existing legacy runs without manifests still require originals.

Always freezing old source on resume would hide deliberate child edits;
requiring current originals would strand generated children. Leaf cache keys
remain based on actual call arguments so changing later child logic does not
invalidate earlier unchanged work. Revisit this selection policy if reference
documentation establishes a different contract.

Worktree cleanup compares ignored files against their post-setup content
baseline as well as Git branch, commit and status. Changed or newly created
ignored content is preserved; unchanged ignored copies can be removed. Hashing
ignored copies adds I/O, so symlinking large caches avoids hashing their targets
while retaining the documented shared-write tradeoff. Partial setup errors,
including failed checkout hooks after registration, preserve structured artifact
metadata and the underlying cause. Cached worktree metadata is historical;
resume does not recreate deleted worktrees.

## Preflight static references; validate computed references at call time

A backend or child path computed from a model result cannot be known at launch.
The CLI checks the default and statically visible selections before agent work.
Computed selections are checked at the call boundary. Restricting JavaScript to
make complete static discovery possible would break script portability.

## Process support

Owned process groups and bounded termination escalation currently support macOS
and Linux. Windows must use WSL until equivalent Windows Job Object process-tree
ownership is implemented and tested. Drivers must fail explicitly on unsupported
hosts.

Each backend runs beneath a small Node supervisor that anchors its process
group. It kills the group when the vendor exits or the workflow owner's IPC
connection dies, including a forcibly killed or suspended owner. Vendor stdio is
inherited, but supervisor IPC is private. SIGTERM allows a one-second grace
period. This avoids historical PID registries and process-list reconstruction.
Post-exit output draining is bounded to one second: uncertain cleanup fails the
run and preserves its worktree. Descendants deliberately creating new sessions
are outside ordinary process-group containment; this is not an OS sandbox.

## Foreground and background run control

The reference runs in the background inside its harness. A standalone command
runs in the foreground by default to compose with shells and CI; `--background`
returns a run ID after preflight, and `wait`, `stop`, and `skip` operate on that
run. A token-authenticated loopback connection proves run identity. A reused PID
is not authorization to signal a process. Control closes even if terminal
persistence fails. Failed startup-log relocation preserves the successful launch
and returns its ID with the retained diagnostic location.

Always-background operation was considered but would force every shell caller to
issue a second command for the result. Revisit the default if actual harness
usage favors it. Commands support both execution styles without changing script
semantics. The notice prints once per run-storage root and always appears in
`info`.

## Explicit resource and layer overrides

The vision asks for one override surface per runtime layer. `sandbox` adjusts
memory and instruction limits without adding host APIs. `transport` adjusts
agent, discovery and background startup deadlines. `schemaStrategy` can force
prompted output. `sharedPaths` supplies opted-in local state to worktrees.
`info` and the skill document these surfaces. Unbounded execution was rejected
because it makes runaway JavaScript and approval hangs indistinguishable from
useful work. Defaults are 64 MiB per VM, 512 KiB stack, 100,000 QuickJS
interrupt checks, 15 minutes per agent attempt, 20 seconds per discovery
request, and two minutes for background readiness. Raise explicit limits rather
than relying on hidden fallback behavior.

Backend discovery is cancellable. Files passed as scripts must be regular files;
streams belong on stdin. Startup cancellation is rechecked before readiness, and
a timed-out launcher cancels and joins its child with bounded signal escalation.
A forced OS kill cannot provide exactly-once external-side-effect guarantees.

## Progressive disclosure and cached artifacts

Progress activity is coalesced at 250 ms; lifecycle and narrator events are
preserved. Full streams always remain in transcripts. The `show` summary lists
agent metadata without embedding every prompt/result. `show --agent` expands one
result, and `--transcript` follows cached transcript lineage. Old run artifacts
must remain available to read their cached transcripts; cache replay does not
recreate deleted worktrees.

The journal matches all agent options, including labels and phases, in
accordance with the reference's prompt-and-options rule. Effective runtime
settings and cwd also participate so changing a timeout, schema strategy, or
working directory cannot silently reuse an outcome from a different execution
contract.

## Reference logging contract

A follow-up Claude Opus 5 consultation confirmed that the authoring skill
specifies `log(message: string): void`; coercion of other values is not
documented. The CLI keeps the string contract. The same consultation explicitly
confirms access to journals and transcripts during resume, but does not specify
whether changed worktrees are recreated. The CLI preserves recorded metadata and
existing artifacts instead of pretending that a cached call reruns git plumbing.

## Discovery and minimal authentication

Literal profile selections preflight their configured backends, alongside
literal backend options. Concurrent computed selections share one in-flight
discovery owned by the root run, so skipping one leaf cannot cancel sibling
discovery. Root cancellation still stops discovery; individual skipped leaves
stop before launch once bounded shared discovery settles. Per-driver caches
remain scoped to the run's driver instances.

Claude bare mode disables OAuth/keychain authentication. To avoid claiming a
capability that immediately fails for normal subscription authentication,
`minimal` is advertised only with a nonempty `ANTHROPIC_API_KEY`. Automatically
running arbitrary API-key helpers during info was rejected; reconsider when
Claude exposes an authoritative side-effect-free bare-auth query. Helper-only
setups are conservatively unsupported. Correction turns preserve the original
tool allow/deny restrictions even if their read-only intersection is empty;
widening that policy would violate the caller's explicit restriction.

Cursor terminal results aggregate earlier narration. Its final assistant message
after tool activity is the return value, verified from complete recorded message
events. Falling back to the terminal aggregate handles streams without that
message; this avoids unnecessary formatting turns without guessing JSON out of
arbitrary prose. Revisit if the vendor changes assistant events to text deltas.

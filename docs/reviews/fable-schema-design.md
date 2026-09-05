# Fable schema correction design review

Model: claude-fable-5-1; 2026-09-05. Bounded recommendation, not completion
approval.

**Recommendation:** replace the rerun loop at `src/runtime/run.ts:492` with a
correction step that never contains the task prompt. Drivers declare one of two
correction modes. ACP backends get true same-session continuation because the
session is already open inside `run()`. CLI backends get a fresh,
tool-restricted formatting turn built only from the prior output, the validation
error, and the schema. No CLI resume flags.

## Why two modes, and which backend gets which

The current loop rebuilds the full request each attempt and appends feedback to
the task prompt. Every driver starts a fresh session per call. The Claude driver
passes `--no-session-persistence`, Codex passes `--ephemeral`, and the ACP
driver closes its connection in the `finally` at `src/drivers/acp.ts:369`. So
retries always rerun the task, and the "do not repeat edits" sentence at
`run.ts:557` is a request the harness cannot enforce.

True continuation is only cheap and observed on one transport. ACP sessions are
multi-turn by protocol, and the connection is live when validation fails. The
CLI backends would need persisted sessions plus a resume flag. That conflicts
with the deliberate no-persistence flags, none of the resume flags are recorded
in BACKENDS.md, and a resumed CLI session reloads full context anyway, so it
costs about the same as a formatting turn while adding state.

| Backend              | Structured                                 | Correction mode | Side-effect guard on the correction                   | Observed?                             |
| -------------------- | ------------------------------------------ | --------------- | ----------------------------------------------------- | ------------------------------------- |
| claude               | native, prompted when forced               | turn            | `--tools Read,Grep,Glob`, keep `--json-schema`        | allowlist plus schema combo unprobed  |
| codex                | native if strict-compatible, else prompted | turn            | `-s read-only` sandbox                                | sandbox observed                      |
| cursor               | prompted                                   | turn            | `--mode ask`                                          | read-only observed; argv cap applies  |
| opencode, kimi, qwen | prompted                                   | session         | none enforceable; instruction only, tool calls logged | second prompt on one session unprobed |

## The bounded change

**Types** in `src/types.ts`. Add `correction: "session" | "turn"` to
`Detection`. Add optional `keepSession?: boolean` to `DriverRequest`. Add
optional `session?: DriverSession` to `DriverResult`, where a session has
`prompt(text)` returning a `DriverResult` and `close()`.

**ACP driver.** When `keepSession` is set, `run()` returns with the connection
open and a session handle whose `prompt` sends another `session/prompt` on the
same session ID, reusing the existing update handler and per-prompt timeout.
`close()` stops the process. Without `keepSession`, behavior is unchanged.
Declare `correction: "session"`.

**CLI drivers.** Declare `correction: "turn"`. No other change. The runtime
builds the correction request itself.

**Runtime loop** in `liveAgent`:

```
first = driver.run({ ...task, keepSession: schema && detection.correction === "session" })
validate; on failure, for attempt in 1..schemaRetries:
  session mode: result = await first.session.prompt(sessionCorrection(error))
  turn mode:    result = await driver.run(turnCorrection(priorText, error, schema))
  validate
finally: await first.session?.close()
```

The turn request carries a short system append that says this is a formatting
step, do not perform any task, do not run tools or edit files. It omits the
profile append and the worktree paragraph. The prompt holds the schema, the
validation error, and the prior response verbatim. It keeps the same cwd, model,
and effort. It passes the native schema when the first attempt was native. It
sets `toolPolicy: "read-only"` only when the detection lists it, so the ACP
throw at `acp.ts:246` is never hit. The session prompt holds only the error and
schema, since the output is already in context.

**No silent truncation.** Drop the 16 kB slice. Claude and Codex take the prompt
on stdin. Cursor's existing argv check turns an oversized prior output into an
errored record with a reason.

**Observability.** Transcript records `{type: "correction", attempt, mode}`
alongside the existing validation error record. The exhaustion reason names the
mode and attempt count. If a correction turn emits tool events, emit a warning
naming the count, which is the only honest guard on ACP. Add `correction` to the
`info` backend line at `src/cli.ts:77`.

**Docs.** One DECISIONS.md entry: corrections never resend the task; CLI resume
was rejected; reversal criterion is a probed multi-turn print mode for a CLI
backend. Update the schema row of the skill and STATUS.

**Tests, offline only.** Extend the existing test at `test/run.test.ts:97` to
assert correction prompts exclude the task text and carry read-only policy. Add
a fake driver returning a session handle and assert one `run`, two `prompt`
calls, one `close`, including close on abort. Replay keys are unchanged because
the mode derives from the backend, which is already in the key.

## Risks

- **Formatting cannot recover missing content.** An agent that edits files and
  answers "Done." now yields null with a reason instead of a rerun that might
  have worked. This is the intended trade under the null contract. Session mode
  on ACP does better because the model can recall its work.
- **ACP cannot enforce read-only.** A session correction could still call tools.
  The instruction plus the warning is the ceiling, and `info` already says so.
- **Three unverified behaviors need one cheap probe each** with a recorded
  fixture: Claude's tool allowlist combined with `--json-schema`, Cursor's ask
  mode with a prompt-only turn, and a second prompt on one ACP session for each
  of the three servers.
- **ACP process death between turns** ends the record as errored with a reason.
  I recommend no fallback to a fresh formatting turn, since a cascade
  reintroduces a second path and the prior text stays in the transcript for
  diagnosis.
- **Native dialect mismatch.** If a backend's forced tool accepts something Ajv
  rejects, corrections loop to the bound. The existing bound and reason cover
  this.

**Companion, optional:** the whole-text fence regex at
`src/runtime/schema.ts:81` causes most prompted failures. Accepting exactly one
fenced block anywhere in the text would cut correction frequency, at the risk of
picking a quoted example when prose contains one. Keep it a separate decision.

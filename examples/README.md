# Runnable recipes

Run `workflow info` first and choose an installed backend and model. Every
review recipe requests `toolPolicy: 'read-only'`; use a backend that advertises
it (Claude, Codex, Cursor, or Muse in the verified installation). ACP backends
explicitly reject that restriction. These scripts inherit the run-level
backend/model; they contain no vendor-specific model names. Live runs consume
subscription quota.

```sh
workflow run ./examples/adversarial-verify.js --backend claude --model <model-from-info> \
  --args '{"task":"Review /absolute/repo/src/cache.ts","findings":["The cache retains expired entries"]}'
```

Use `--args-file ./input.json` for larger inputs. Prompts must include the whole
task and absolute paths: leaves do not receive the parent conversation. Set
scope and limits for the actual task; example bounds are explicit teaching
choices, not product limits.

| Script                                                         | Required input                                           | Behavior                                                                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [hello.js](hello.js)                                           | None; optional `backend`, `model`                        | One structured greeting; can use any available backend.                                                                  |
| [adversarial-verify.js](adversarial-verify.js)                 | `task`, `findings` array                                 | Three independent refuters per claim; two positive votes required; returns dissent and failed votes.                     |
| [perspective-diverse-verify.js](perspective-diverse-verify.js) | `task`, `claim` string                                   | Correctness, security, performance and reproduction reviews, then synthesis with missing coverage reported.              |
| [judge-panel.js](judge-panel.js)                               | `task`                                                   | Three independent attempts, two judges per attempt, explicit rubric, deterministic ties, then synthesis from the winner. |
| [loop-until-dry.js](loop-until-dry.js)                         | `task`; optional `maxRounds` (8)                         | Two dry rounds; remembers rejected IDs, deduplicates within rounds, and reports failure or limit exits.                  |
| [loop-until-budget.js](loop-until-budget.js)                   | `task`; optional `maxRounds` (3), `reserveTokens` (2000) | Guards deferred budget and uses a finite announced fallback.                                                             |
| [multi-modal-sweep.js](multi-modal-sweep.js)                   | `task`                                                   | Independent search strategies, cross-searcher deduplication, then verification pipelines.                                |
| [completeness-critic.js](completeness-critic.js)               | `task`, `requirements` array, `evidence`, `result`       | Final critic identifies missing requirements and unsupported completion claims.                                          |
| [no-silent-caps.js](no-silent-caps.js)                         | `task`, `items` string array; optional `limit` (12)      | Logs duplicate, deferred and failed items and returns the omitted queue for follow-up.                                   |

Pipeline is the default: a fast candidate starts judging while another candidate
is still being generated. Barriers occur only when synthesis, selection or
cross-item deduplication needs the complete prior set. Searchers use stable
location-plus-cause IDs for deterministic exact deduplication; semantic
duplicates with different IDs may still require a separate cross-finding
deduplication stage. A majority or winning score is evidence to assess, not
proof of truth.

The offline `test/examples.test.ts` executes these exact files in the real
sandbox with controlled agent responses and schema validation. It covers failed
votes, ties, missing coverage, rejected-identity convergence, duplicate
findings, explicit limits and omissions. It invokes no real agents.

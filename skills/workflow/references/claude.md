# Claude model selection

These are opinionated defaults for the Haiku 5.5, Sonnet 5.5, Opus 5.5 and Fable
5.1 generation. Prefer newer models in the same tier when `workflow info` lists
them.

Haiku is fast and cheap. Use Haiku for extraction, summaries, or small bounded
assignments.

Sonnet is a good balance of capability and price. Use Sonnet for straightforward
coding assignments.

Opus is highly capable and reasonably priced. Use Opus for difficult debugging,
scoping, architecture tradeoffs, keystone implementation, frontend design,
adversarial verification, and writing readable, mergeable code.

Fable is slow and very expensive. Use it for the most difficult reasoning, only
if GPT Astra is not available, or if the user explicitly asks. If selecting
Fable for a workflow, get explicit authorization from the user first; don't
surprise them by burning Fable tokens.

Use medium, high, or xhigh effort levels depending on the task. Avoid low except
with Fable. Avoid max.

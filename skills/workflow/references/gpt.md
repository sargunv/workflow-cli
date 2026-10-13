# GPT model selection

Last checked 2026-10-13. At the time of writing, 6 Luna, 6.1 Sol, and 6 Astra
are the latest GPT models.

Luna is fast and cheap. Use Luna for extraction, summaries, or small bounded
assignments at volume.

Sol is capable and persistent, and a good balance of capability and price. Use
Sol for routine implementation through complex technical work or scoped
refactoring, or for any computer use.

Astra is slow, expensive, but _highly_ capable. Use Astra for architecture
decisions or difficult diagnosis especially when you have hard-to-reproduce
bugs. Astra can often diagnose the bug correctly by reading all relevant
sources.

If selecting Astra for a workflow, get explicit authorization from the user
first; don't surprise them by burning Astra tokens.

Use medium, high, or xhigh effort levels depending on the task. Avoid low except
with Astra.

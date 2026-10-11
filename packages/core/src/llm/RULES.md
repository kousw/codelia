# Model delivery rules

- Preserve canonical completions and default compatibility for existing adapters/callers.
- Await optional text sinks; do not fire-and-forget or allocate an unbounded delta queue.
- Leave retry attempt identity, history mutation and stream settlement to Agent.
- Do not forward reasoning, raw provider diagnostics or incomplete tool arguments as assistant text.

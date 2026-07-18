# Agent loop

`agent.ts` owns run lifecycle ordering: history enqueue/commit, session records, usage, compaction, emitted event order, permission checks, and tool execution.

`model-output.ts` is the pure provider-response normalization boundary. It converts model messages into reasoning text, assistant text, function tool calls, and hosted-tool summaries without mutating agent state or emitting events.

Do not move history/session writes or event sequencing into normalization helpers. Extract additional code only when its inputs and outputs can be expressed without passing the `Agent` instance or a general-purpose runtime context.

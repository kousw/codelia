# Agent loop

`agent.ts` owns run lifecycle ordering: history enqueue/commit, session records, usage, compaction, emitted event order, permission checks, and tool execution.

`model-output.ts` is the pure provider-response normalization boundary. It converts model messages into reasoning text, assistant text, function tool calls, and hosted-tool summaries without mutating agent state or emitting events.

`model-context.ts` calculates context-left percentages from an explicit usage/model-registry DTO. `tool-execution.ts` owns one tool invocation, its permission callback boundary, dependency context, and result normalization. Neither module may mutate Agent history, write session records, or emit lifecycle events.

Do not move history/session writes or event sequencing into normalization helpers. Extract additional code only when its inputs and outputs can be expressed without passing the `Agent` instance or a general-purpose runtime context.

- `AgentRunOptions.pollMessages` supplies external context before model steps and
  before natural final completion. Add hidden user messages only at these safe
  boundaries; never interleave a pending tool-call batch or reset iteration budgets.

- `ToolPermissionDenied` carries denial decisions made inside a tool execution
  gate. Normalize it through the same permission-denied result as the hook,
  preserving `stop_turn` and reason without converting it to task success.

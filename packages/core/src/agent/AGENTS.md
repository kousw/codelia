# Agent loop

`agent.ts` owns run lifecycle ordering: history enqueue/commit, session records, usage, compaction, emitted event order, permission checks, and tool execution.

`image-input.ts` materializes fixed image representations without a rolling last-N window:
appending an image must preserve the previously sent prefix for LLM cache reuse.
It does not mutate durable history or auto-resolve compaction's artifact registry.
The 32 MiB/image artifact validation remains, but there is no fixed 12 MiB aggregate
history budget. Missing/corrupt originals abort rather than silently replacing old
images with text. Explicit or normal context-triggered compaction resets the prefix;
then image_inspect can reintroduce originals. Without a resolver, refs remain text.
Normal/retry requests and the max-step summary use this boundary. Resolvers must
return the representation pinned by each ref across calls and resume, not expiring
URLs. `image_ref.model_view` pins JPEG view bytes; its absence always means original
bytes. Transfer estimates use view size, vision estimates keep original dimensions.

`image-context.ts` separates approximate text/vision tokens from encoded transport
bytes. `../llm/image-policy.ts` supplies versioned model-family estimates; unknown
models/dimensions use an explicitly marked heuristic, or the model's optional
`estimateImageTokens` hook. Never bill from these estimates or add image tokens to
provider usage a second time. Agent calibrates the unchanged prefix against the
last observed input usage, estimates only subsequent growth, and resets calibration
on history replacement/compaction. Transfer limits never trigger auto-compaction.
Attachment image_ref parts retain their original detail setting across replay.

Generic `attachment_ref` parts retain store-owned metadata in originals and
checkpoints. Model invocation projects the descriptor in place, using the
existing image resolver for copied image originals. Textual compaction receives
descriptors. Tools can supply a static display substitute or set
`ToolResult.display_content` for one successful result. The substitute is
used in transcript and diagnostics while original content remains available
to the model and original conversation records.

`model-output.ts` is the pure provider-response normalization boundary. It converts model messages into reasoning text, assistant text, function tool calls, and hosted-tool summaries without mutating agent state or emitting events.

`model-context.ts` calculates context-left percentages from an explicit usage/model-registry DTO. `tool-execution.ts` owns one tool invocation, its permission callback boundary, dependency context, and result normalization. Neither module may mutate Agent history, write session records, or emit lifecycle events.

Do not move history/session writes or event sequencing into normalization helpers. Extract additional code only when its inputs and outputs can be expressed without passing the `Agent` instance or a general-purpose runtime context.

- `AgentRunOptions.pollMessages` supplies external context before model steps and
  before natural final completion. Add hidden user messages only at these safe
  boundaries; never interleave a pending tool-call batch or reset iteration budgets.

- `ToolPermissionDenied` carries denial decisions made inside a tool execution
  gate. Normalize it through the same permission-denied result as the hook,
  preserving `stop_turn` and reason without converting it to task success.

- Model context carries a turnKey (run_id or one ephemeral UUID per runStream)
  independently of sessionKey. `llm/provider-status.ts` drains `llm.status` while
  the existing retry coordinator awaits requests; consumer teardown aborts work.
  These statuses remain display events and never enter assistant/model history.

- Await optional `AgentSession.recordMessages` for admitted user/polled messages,
  canonical responses and original tool results before mutable context processing.
  Archival failure stops admission; never convert a storage failure to a tool error
  and continue. Compaction summaries and regenerated startup context are not originals.

- `AgentRunOptions.runContext` is a transient user message at the run boundary,
  after prior history and before current input and steers. Include it in tool
  steps and the max-iterations summary. Keep it out of originals and checkpoints.

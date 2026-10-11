# Model text streaming

Status: Partial, implemented vertical slice, 2026-10-07. OpenAI HTTP Responses emits live text through the shared contract. OpenAI WebSocket and other provider adapters retain buffered completion delivery; supporting an adapter requires the same lifecycle/backpressure tests. This does not stream reasoning or unfinished tool arguments.

`BaseChatModel.ainvoke` still returns the canonical `ChatInvokeCompletion`. Optional `ChatInvokeContext.onTextDelta(text): Promise<void>` supplies transient assistant text; adapters **must await** it. Agent owns a single-event rendezvous, invocation UUID, retry attempt and stream identity. The opt-in `AgentRunOptions.streamText` is false by default. Normal SDK callers, TUI and model compaction remain completion-based.

`AgentEvent` adds `text.stream`, inside the existing runtime `agent.event {run_id,seq,event}` envelope:

- Common fields: `invocation_id`, positive `attempt`, unique `stream_id`.
- `phase: start`: reserve one provisional assistant row.
- `phase: delta`: append `content` only at the exact UTF-8 byte `offset`.
- `phase: discard`: remove only this failed/uncommitted attempt.
- `phase: commit`: replace the preview with authoritative canonical assistant text after history commit.

There is at most one outstanding awaited delta. Chunks are split on Unicode characters (at most 4097 UTF-16 units / 16 KiB UTF-8); transient content is capped at 2 MiB per attempt. Further preview text is omitted while the adapter continues building the canonical completion. Canonical text retains existing transcript/frame limits. Consumer return/abort closes the rendezvous, rejects a waiting producer, aborts the child invocation signal and removes listeners. Retry-window expiry continues to govern only waits/admission, never a healthy active request.

Failed/cancelled attempts do not commit assistant messages, usage or `llm.response`. A retry discards the old stream before retry notice/new stream. Run cancellation also removes outstanding provisional rows when the runtime stops forwarding events. Late events are ignored by run ownership, sequence marks, stream identity, invocation/attempt identity and exact byte offsets. Stream records and recent identities are bounded. Canonical legacy `text`/`final` optionally carry `stream_id` so a live client reconciles the same row without duplicating text; older clients still receive canonical events without requiring the new lifecycle.

Runtime enables live text only when the UI opts into `supports_text_stream`; the server advertises it. It awaits transient transport delivery (stdio write callback or ordered host sink), while cancellation releases a producer waiting on a stalled sink. A previously enqueued host notification can arrive late, so clients must retain run/sequence checks. Transient events never enter session event logs or trigger per-delta snapshots. Existing canonical model/history/session records remain authoritative for restart and replay; replay contains no partial/failed attempt events. Reconnect does not resume or retry an unknown invocation automatically.

Validation includes real loopback SSE held before completion, mid-stream cancellation, canonical session history replay, unchanged approval/child orchestration checks, mock-model failed-attempt recovery/consumer return/large Japanese chunks, a stalled host-sink cancellation test and Rust stream projection regressions. Native GUI streaming and all-provider parity remain unverified. This contract does not establish exactly-once tool side effects across restart; that belongs to desktop roadmap M2.

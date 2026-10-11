# Model invocation boundary

`base.ts` is the provider-neutral invoke contract. `ainvoke` returns canonical completion; optional `context.onTextDelta` is an awaited transient assistant-text sink. Adapters must await every callback and honor the invocation signal. Never couple this boundary to runtime/protocol/GPUI or commit partial text to history. Agent owns stream identity, retry, commit/discard and UI event ordering. Unsupported transports remain buffered. See `dev-docs/specs/model-text-stream.md` and provider directory instructions.

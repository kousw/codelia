# LLM adapters

`stream-timing.ts` owns provider-neutral monotonic observed-stream timing.
Create a fresh tracker per transport attempt; observe nonempty output deltas and
freeze on the terminal event. Attach optional `timing` to the completion before
debug/final-response postprocessing. See diagnostics spec section 4.2 and
`packages/core/tests/stream-timing-adapters.test.ts` for WS fallback and initial-wait invariants.

Responses hidden reasoning starts its generation interval at the first reasoning
item-added event; first-delta latency remains separate. Preserve reasoning token
counts in normalized usage so metrics can reject an unmatched hidden-token rate.

Provider-specific auth, requests, retry classification and response restoration
remain in the provider directories.

`provider-status.ts` forwards optional model-context progress while awaiting the
existing retry iterator. Keep retry ownership in `retry.ts`; progress must not
start another request or alter model history. Close cancels pending inference.

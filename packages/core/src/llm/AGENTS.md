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


Live output forwarding coalesces adjacent deltas without prefix/tail loss. Do not add arbitrary queue eviction: TUI retains the full response during generation and relies on canonical events only for final reconciliation and persistence.

`error-diagnostics.ts` supplies static trusted parser causes and allowlisted nested transport codes. Retry terminal errors retain these safe details; never replace them with raw provider messages. HTTP SDK failures may expose `statusCode` instead of `status`.
Opt-in provisional deltas (`ChatInvokeInput.onDelta`) are observed in the same
stream loop as `LlmStreamTiming`; never add a second pass over a stream or
change the non-delta path when the sink is absent.

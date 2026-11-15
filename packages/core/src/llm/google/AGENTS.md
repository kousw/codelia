# Google Interactions chat adapter

`ChatGoogle` uses the official `@google/genai` Interactions API with explicit
`store=false`. `serializer.ts` preserves provider `thought`, `function_call`,
and `model_output` steps in durable message metadata. Do not strip signatures,
IDs, empty thought summaries, or tool-result order on replay. `stream.ts` only
returns a turn after a terminal `interaction.completed` and all `step.stop`
events. Unknown content or deltas fail closed. SDK retries remain disabled;
  the Agent owns cross-provider retries. After Prepay funding on 2026-11-02,
  live stateless two-turn chat and a signed function-call/result round trip passed.

Raw `function_call` replay is gated by the matching ID in canonical
`assistant.tool_calls`. Cancellation/history normalization may remove an
unmatched call while leaving its provider metadata; never resurrect that call.

`ChatGoogleOptions.thinkingLevel` accepts Hydrogen's native `xhigh`. Runtime
owns model-specific canonical effort fallback; unset effort must still omit
the API field. Carbon/Hydrogen use the same synchronous 65,536 output cap and
`automatic_continuation=false`; SDK fixtures cover the new wire values.

Stream/response validation raises `createProviderResponseError` with static safe cause codes; preserve terminal/step validation and non-retryable malformed-response behavior. Official Interactions HTTP exceptions may expose `statusCode`; common extraction recognizes it without reading the raw body.

`ChatGoogle` creates the timing tracker before awaiting SDK stream setup.
`stream.ts` marks thought-step starts as `generation_start_source: thought_step`
and observes text/tool-argument deltas or nonempty step-start output snapshots.
Signature-only events do not establish first output; `interaction.completed`
freezes timing. `packages/runtime/tests/google-metrics.test.ts` verifies
reasoning usage, text/tool/snapshot timing and runtime TPS together.

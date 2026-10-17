# Named Responses endpoint contract

Status: implemented, live inference-gateway validation pending.

- Config `providers.<name>.type=responses` separates endpoint identity from adapter kind. `ProviderName` accepts configured names; runtime resolves only builtin or configured names. Builtin provider names cannot be replaced.
- `packages/config/src/responses-provider.ts` validates URL/features/model limits without I/O; provider maps merge by name with complete replacement. Keys live in independent auth entries or explicitly named environment variables.
- `ChatResponses` in `packages/core/src/llm/responses` uses stateless HTTP streaming, shared serializer/accumulator and allowlisted options. SDK retries are fixed at zero; `BaseChatModel.retryPolicy` overrides Agent defaults. Successful streams cannot be replayed automatically.
- `packages/runtime/src/responses-provider.ts` generates qualified registry IDs (`endpoint/model`) with provider-scoped raw-model aliases. Registry lookups must respect the requested provider even on direct ID hits. Config metadata replaces all external catalog acquisition for named endpoints.
- `model.list` returns optional `providers` and per-model `reasoning_levels`; `initialize` returns optional `model_providers`. Older clients can ignore these additive fields; the TUI falls back to builtin provider/effort lists when absent.
- Parent factories supply endpoint declarations to model registry and child bootstrap. Bootstrap validates a snapshot; children do not load project config or probe network at admission. Explicit child/profile selections keep the parent endpoint definitions while replacing model tuning settings.
- HTTP/SSE failures expose safe status/code through `ProviderFailure` and run-error records. Raw upstream messages/headers never enter user-facing errors. Off means one POST across SDK/Agent/child paths.
- TUI registration wizard, named endpoint concurrency control and cold-start progress are deferred. Actual gateway/Strata connection acceptance remains unverified.

User workflow and configuration: [custom Responses providers](../../../docs/responses-providers.md).

# @codelia/core

Domain SDK package (`src/index.ts` -> `dist/`). No RPC, auth, sandbox, or storage implementations.

## Core & Services

- DI interfaces live in `src/di/`; config defaults register in `src/config/register.ts`.
- Default system prompt loads from `getDefaultSystemPromptPath()` (`prompts/system.md`, overridden by `CODELIA_SYSTEM_PROMPT_PATH`). Keep `prompts/system.md` cross-repo and high-level (tool limits/params belong in tool schemas; benchmark rituals in adapters; interactive subagent use requires explicit user task authorization).
- `AgentServices.monotonicNowMs` measures `step_complete.duration_ms` only; keep wall timestamps separate and never route timeouts through it.
- `defineTool` normalizes object unions (`anyOf`/`oneOf`) to top-level `type: "object"`; `prepareToolInvocation` binds one Zod normalization to execution for unchanged registrations.
- `ContentPart.image_ref` resolves lazily through `AgentServices.resolveImage` (`src/agent/image-input.ts`) immediately before model requests without a rolling last-N window (preserving LLM prefix cache). Missing/corrupt originals abort rather than substituting text; unresolved images must never be described as inspected. `image-context.ts` calibrates unchanged prefixes against observed input usage and resets on compaction (transfer limits never trigger auto-compaction; image token estimates never trigger billing or double-count observed usage).
- `attachment_ref` parts project in place via store/image resolvers; tools can supply `ToolResult.display_content` for transcript/diagnostics while keeping original content in model history and archives.

## Agent Loop, History & Compaction

- `src/agent/agent.ts` owns run lifecycle ordering. `model-output.ts`, `model-context.ts`, and `tool-execution.ts` stay pure without passing `Agent` or mutating history/session state.
- `AgentRunOptions.pollMessages` injects hidden user context only before model steps and natural final completion (never inside a tool batch or resetting iteration budgets). `AgentRunOptions.runContext` is transient per run (included in steps and max-iterations summary, excluded from originals and checkpoints).
- Await `AgentSession.recordMessages` for admitted user/polled messages, canonical responses, and original tool results before mutable context processing; archival failure stops admission.
- `ToolPermissionDenied` flows through the same permission-denied path as `canExecuteTool`, preserving `stop_turn` and reason.
- `HistoryAdapter` (`src/history/`) is the active model view, not the durable archive. Immediate tool-output cache processing preserves non-text `ContentPart[]` (`image_url`, `document`, `other`) while persisting text projections when cached; runtime disables total-budget replacement trimming by default.
- Compaction prefers `maxInputTokens` over `contextWindow` (default `thresholdRatio: 0.85`); `Agent.getContextLeftPercent()` falls back to `llm.model` for unindexed provider usage IDs. Retained tails drop `tool`/`reasoning`/`assistant.tool_calls`, carry `[codelia.compaction.retain]` verbatim (excluding markers from summarization and skipping if only markers remain), and invoke `BaseChatModel.onHistoryCompacted(context)`. `Agent.getContextUsage()` estimates categories without fetching images.
- `Agent.runStream()` yields `text`/`reasoning`/`final` (with `final` last); `llm.status` events are never persisted into assistant/model history. With `streamDeltas: true`, `invokeModelWithRetry` attaches a per-attempt `onDelta` sink (`stream_id` per attempt; late deltas ignored) drained by `withProviderStatus` (merges consecutive deltas by `(type, stream_id, index)` with no queue eviction, observes pending step promises on creation, and cancels inference on early close).

## Models & Retry Boundaries

- Static specs live in `src/models/` (`DEFAULT_MODEL_REGISTRY`). Set `supportsFast`/`supportsVision` only for verified IDs; entries usable without models.dev must carry positive `maxInputTokens` or `contextWindow`. Use `ModelSpec.providerModelId` when selectable capped/alias IDs differ from API model IDs, and preserve dynamic alias buckets per provider when cloning registries.
- `src/llm/retry.ts` owns interactive step retries (defaults: 2 retries / 3 attempts, 1s–60s backoff/hint ceilings, 20-min retry window). Never pass the retry window's abort signal into an active provider request; transports own connect/request/first-byte/stream-idle timeouts with SDK retries disabled.
- `ProviderName` is canonical in `@codelia/shared-types`. Classified terminal failures throw `ProviderFailureError` / `ProviderTimeoutError` / `createProviderValidationError` with redacted `safeMessage` (never raw provider messages, stacks, or org/key identifiers in normal events).

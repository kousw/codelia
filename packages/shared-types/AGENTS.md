# @codelia/shared-types

Zero-dependency package for stable cross-boundary types shared by `core`, `protocol`, `runtime`, and `storage`.

- Keep provider-specific error categories, transport fields, and implementation internals out of this package.
- Keep `ImageArtifactRef` / `ImageArtifactMetadata` (`model_view` is admission-time only — never retroactively attach to legacy refs), `ProviderName` (canonical union re-exported by Core), `LlmCallTiming` (`generation_start_ms`/`source` separate from first output), `ModelReasoningLevel`, `ModelFastMode`, `AgentEvent` (`llm.status`, `permission.preview`/`ready`, provisional `text.delta`/`reasoning.delta`), `SessionStateSummary`, schema-first `Skill*` (`src/skills/schema.ts`), `RunErrorInfo`, `ContextUsage`, and `TaskProgress` backward-compatible across persistence, RPC, and replay.

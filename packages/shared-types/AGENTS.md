# @codelia/shared-types

Package containing stable types shared by `core/protocol/runtime/storage`.

Design principles:
- Minimal dependencies (no dependencies on external SDKs/other workspace packages).
- Limit types to those that require long-term compatibility for persistence/RPC/UI playback.
- Do not include provider-specific or implementation-specific internal types.

Current target:
- `ImageArtifactMetadata` distinguishes attachments (`kind: attachment`) from
  generated PNGs (legacy absent kind is supported). `ImageArtifactRef` identifies
  immutable PNG/JPEG/WebP/GIF bytes; format support for generation is a separate
  runtime contract, not implied by storage/vision support. Optional `model_view`
  pins a versioned hashed model-input representation; absence means original bytes.
  It belongs on new history references, never retroactively on legacy refs.
- `ProviderName`
  - canonical provider identifier union used by shared events and re-exported by Core's LLM boundary
  - provider-specific error categories and transport details remain in Core provider modules
- `LlmCallTiming` is the optional monotonic first-output/generation interval
  shared by completion/session/protocol metrics; it carries no provider payload.
  Optional generation_start_ms/source identifies a Responses reasoning-item
  activity marker, separately from first observable delta latency.
- `ModelReasoningLevel` and `MODEL_REASONING_LEVELS`
  - canonical cross-package reasoning levels used by core, protocol, and runtime
  - provider-specific supported subsets remain in provider/runtime modules
- `AgentEvent` series
	- `llm.status` carries allowlisted informational verification/buffering status;
	  it contains no opaque provider payload and must never become assistant text.
  - includes structured permission preflight events: `permission.preview` / `permission.ready`
  - `permission.preview` supports optional `language` and `file_path` hints for UI diff syntax highlighting
- `SessionStateSummary`
- `Skill*` type used for skills catalog/search
  - schema-first: `src/skills/schema.ts` (Zod) + `src/skills/index.ts` (infer types)

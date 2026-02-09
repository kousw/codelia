# @codelia/shared-types

Package containing stable types shared by `core/protocol/runtime/storage`.

Design principles:
- Minimal dependencies (no dependencies on external SDKs/other workspace packages).
- Limit types to those that require long-term compatibility for persistence/RPC/UI playback.
- Do not include provider-specific or implementation-specific internal types.

Current target:
- `AgentEvent` series
- `SessionStateSummary`
- `Skill*` type used for skills catalog/search
  - schema-first: `src/skills/schema.ts` (Zod) + `src/skills/index.ts` (infer types)

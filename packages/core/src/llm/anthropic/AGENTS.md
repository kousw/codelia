# Anthropic (Claude) provider

- Uses `@anthropic-ai/sdk` messages API.
- Both normal and beta Fast paths use `messages.stream()` and `finalMessage()`;
  observe content deltas and `message_stop` for timing before debug dumps.
- Serializer maps core message/tool types to Anthropic content blocks.
- HTTP(S) `image_url` parts map to `image.source.type=url` in user messages and tool results; inline data URLs retain base64 sources. No download occurs in the serializer.
- Tool calls are emitted as `tool_use` blocks; tool results as `tool_result` blocks.
- System prompts are merged into a single `system` string.
- Before orphan filtering, serializer coalesces consecutive assistant messages that contain `tool_use` blocks into a single assistant turn so `tool_use` is adjacent to the following user `tool_result` turn (Anthropic-compatible turn shape).
- Sonnet/Haiku 5.5 use adaptive summarized thinking and safe local input checks;
  Sonnet rejects forced tools while Haiku retains them. See
  `dev-docs/specs/providers/anthropic-provider.md`.
- For these two models, retain complete ordered assistant turns and signed/empty/
  redacted thinking. `thinking.ts` binds raw blocks to durable canonical prefix
  fingerprints, filters invalid/unbound replay, and strips local fields before
  transport. Text `AssistantMessage.provider_meta` retains original text blocks;
  tool calls retain their existing provider metadata. Do not use a permanent
  server drop-block beta or change the legacy-model path implicitly.

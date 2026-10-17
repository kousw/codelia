# Anthropic (Claude) provider

- Uses `@anthropic-ai/sdk` messages API.
- Both normal and beta Fast paths use `messages.stream()` and `finalMessage()`;
  observe content deltas and `message_stop` for timing before debug dumps.
- Serializer maps core message/tool types to Anthropic content blocks.
- HTTP(S) `image_url` parts map to `image.source.type=url` in user messages and tool results; inline data URLs retain base64 sources. No download occurs in the serializer.
- Tool calls are emitted as `tool_use` blocks; tool results as `tool_result` blocks.
- System prompts are merged into a single `system` string.
- Before orphan filtering, serializer coalesces consecutive assistant messages that contain `tool_use` blocks into a single assistant turn so `tool_use` is adjacent to the following user `tool_result` turn (Anthropic-compatible turn shape).

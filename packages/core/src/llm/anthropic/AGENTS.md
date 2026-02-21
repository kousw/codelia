# Anthropic (Claude) provider

- Uses `@anthropic-ai/sdk` messages API.
- Serializer maps core message/tool types to Anthropic content blocks.
- Tool calls are emitted as `tool_use` blocks; tool results as `tool_result` blocks.
- System prompts are merged into a single `system` string.
- Before orphan filtering, serializer coalesces consecutive assistant messages that contain `tool_use` blocks into a single assistant turn so `tool_use` is adjacent to the following user `tool_result` turn (Anthropic-compatible turn shape).

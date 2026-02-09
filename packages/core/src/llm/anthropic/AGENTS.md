# Anthropic (Claude) provider

- Uses `@anthropic-ai/sdk` messages API.
- Serializer maps core message/tool types to Anthropic content blocks.
- Tool calls are emitted as `tool_use` blocks; tool results as `tool_result` blocks.
- System prompts are merged into a single `system` string.

# OpenRouter provider

- Uses OpenRouter Responses API via OpenAI SDK client with OpenRouter base URL.
- Tool calls are mapped to `function_call` items and tool outputs to `function_call_output`.
- Serialization helpers live in `serializer.ts`.
- Response input/output utility helpers live in `response-utils.ts`.

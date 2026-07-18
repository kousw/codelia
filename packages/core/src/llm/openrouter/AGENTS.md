# OpenRouter provider

- Uses OpenRouter Responses API via OpenAI SDK client with OpenRouter base URL.
- Tool calls are mapped to `function_call` items and tool outputs to `function_call_output`.
- Preserve image-bearing tool outputs as a `function_call_output.output` content array containing `input_image`; OpenRouter's Responses contract accepts the same input content parts as user messages, so do not stringify or synthesize a separate user turn without provider-specific evidence.
- Serialization helpers live in `serializer.ts`.
- Response input/output utility helpers live in `response-utils.ts`.

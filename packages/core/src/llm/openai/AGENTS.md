# OpenAI provider

- Uses OpenAI Responses API; message history is serialized into response input items.
- Tool calls are mapped to `function_call` items and tool outputs to `function_call_output`.
- Serialization helpers live in `serializer.ts`.
- OpenAI-specific history adapter lives in `history.ts` (canonical = response.output).

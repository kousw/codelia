# Z.ai provider

- `chat.ts` owns the `BaseChatModel` adapter: request construction, provider
  diagnostics, and conversion to `ChatInvokeCompletion`.
- `transport.ts` owns HTTP request execution, SSE parsing, timeout/signal
  composition, and HTTP error normalization.
- `serializer.ts` owns provider-neutral message/tool/reasoning normalization.
- Keep raw stream chunks out of persisted `provider_meta`. Count chunks by
  default, and capture full raw chunks only for explicit provider dump output.
- `reasoning_effort` is sent only for models that support it (`glm-5.2` in the
  static registry). Other Z.ai models still send `thinking: { type: "enabled" }`
  and use provider defaults for effort.

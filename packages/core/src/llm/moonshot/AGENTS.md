# Moonshot Provider

- `ChatMoonshot` targets Moonshot's OpenAI-compatible Chat Completions API at
  `https://api.moonshot.ai/v1` and uses `MOONSHOT_API_KEY` through runtime.
- Kimi K3 always thinks. Send `reasoning_effort: "max"` and do not send the
  K2.x `thinking` parameter.
- Preserve Moonshot `reasoning_content` on the immediately following assistant
  message during history replay. Kimi K3 rejects lossy multi-turn/tool replay.
- Moonshot image input accepts only base64 `data:image/png|jpeg|webp|gif` or
  existing `ms://` file ids. Reject public image URLs before transport and keep
  user image content as an array, never serialized JSON text.
- Chat Completions tool messages are kept textual. Collect image parts from
  consecutive tool results and emit one multimodal user message only after all
  tool result messages, preserving multi-tool ordering while letting K3 inspect
  `view_image` output.
- Keep tool-call `provider_meta` compact and never persist raw stream chunks.
- Classify `exceeded_current_quota_error` and TPD-flavored
  `rate_limit_reached_error` as non-retryable `hard_quota`. Only documented
  concurrency/RPM/TPM waits and overload/server failures may enter bounded retry;
  unknown 429 variants fail conservatively.
- `ChatMoonshot` disables OpenAI SDK retries and wraps transport failures as safe
  `ProviderFailureError`. Once any SSE chunk has been buffered, mark the failure
  non-retryable with `delivery=buffered` to prevent replay.
- Hosted/Formula tools and dynamic model-list fetching are not implemented.

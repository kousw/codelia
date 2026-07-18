# xAI provider

`ChatXai` uses xAI's Responses API at `https://api.x.ai/v1` through the OpenAI
SDK transport, but its provider identity remains `xai`.

- Keep `store=false`, include encrypted reasoning, and set `prompt_cache_key`
  from the Codelia session key.
- xAI `grok-4.5` accepts only `low|medium|high` reasoning; runtime owns canonical
  fallback from `xhigh|max` to `high`.
- Preserve PNG/JPEG images. Reject unsupported inline image media before network
  I/O; xAI does not document WebP/GIF input support.
- Reuse the OpenAI Responses serializer only through `serializer.ts`, which
  translates opaque `other` parts between `openai` wire compatibility and `xai`
  shared-history ownership.
- xAI treats function schemas as strict even when Codelia emits `strict:false`;
  runtime Zod validation remains authoritative.
- Reject xAI hosted web search when `allowed_domains` contains more than five
  entries; the shared search config is intentionally provider-neutral.
- Build xAI Web Search wire tools from an explicit supported-field allowlist.
  Do not forward shared `search_context_size` or `user_location`; preserve the
  supported `filters.allowed_domains` shape.
- Keep X Search as `search_kind: "x"` in Codelia's hosted-tool union and emit the
  xAI-only `type: "x_search"` wire tool locally in `serializer.ts`; do not make
  OpenAI/Anthropic serializers understand it.
- X Search is explicit opt-in. Normalize a leading `@`, enforce the 20-handle
  limit and allow/exclude mutual exclusion, and validate inclusive ISO calendar
  dates before transport.
- Normalize `x_search_call` as reasoning with its raw item intact so Agent emits
  the `XSearch` hosted-tool lifecycle and later stateless requests can replay it.
- Preserve output-text annotations in `provider_meta.citations`; do not add
  opaque citation blobs to display content.
- Keep provider diagnostics free of API keys and raw auth headers.

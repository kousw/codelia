# DeepSeek provider

Status: implemented; checked 2026-11-02. Runtime provider is `deepseek`, SDK
adapter is `ChatDeepSeek`. Only these two selectable model IDs are registered:

| Model ID | Current official version | Context / max output | Vision |
| --- | --- | --- | --- |
| `deepseek-flash` (default) | DeepSeek-V4.1-Flash-1017 | 1M / 384K | Yes |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 1M / 384K | No |

Flash uses the official rolling ID; it is not a pinned 1017 version. No legacy
V3/R1 or synthetic version IDs are added. Static limits use conservative decimal
1,000,000 / 384,000 tokens. Model listing and context budgeting work without
models.dev entries. Provider-specific `default` resolves to `deepseek-flash`.

## Authentication and transport

Use `DEEPSEEK_API_KEY` or the saved `deepseek` API-key entry. OAuth is unavailable.
Authentication is isolated from OpenAI/Codex and other providers. No literal key
belongs in config or documentation. `.env` remains ignored.

The thin adapter composes existing `ChatResponses` at the fixed
`https://api.deepseek.com/responses` endpoint. Requests use streaming HTTP and
full local history with `store:false`. SDK and Agent retries are disabled. No
WebSockets, server response references, auth/model/endpoint fallback, service
tier, prompt-cache headers, encrypted reasoning, or reasoning summary request
is added. Error details stay behind the shared bounded/redacted failure boundary.

## Reasoning and tools

Native effort is `low|high|max`; canonical `medium|xhigh` maps to `high` and the
requested/applied values are retained in diagnostics. Omitted SDK effort uses
`high`. API `none` is not exposed by current Codelia reasoning controls.

Responses plaintext reasoning items are preserved in durable raw history and
replayed alongside function calls and their results. A low-effort response need
not contain a reasoning item. Unknown/failed/truncated/incomplete responses are
not accepted as successful turns. Existing transport cancellation is preserved.

Function tools and structured output are supported. Flash accepts image input;
Pro image input and hosted tools fail before HTTP. Thinking-mode forced named
tool choice returned HTTP 400 in live testing, so it is rejected locally. No
silent change to thinking or tool choice is made. Native web search, custom
`apply_patch` tools and file IDs are not exposed by this adapter; normal Codelia
local function tools remain available.

Both models have no Fast tier. Switching from another provider clears inherited
boolean Fast in config/session selection; explicit Fast and Ultrafast fail
before persistence. Direct factory construction ignores inherited boolean Fast
and never sends a service tier.

## Verification

Deterministic fixtures cover model IDs/default/alias, request shape, effort
mapping, reasoning/function/result replay, Pro vision rejection, cancellation,
terminal validation, safe failures and one-POST retry behavior through Agent.
Runtime tests cover API-key auth, factory, static listing and speed admission.

The supplied test key passed small live streaming function-call/result round
trips on both models. These prove account access for those requests, not all
efforts, context/output ceilings, vision quality or structured-output behavior.
No server-side search was executed. Opt-in repeatable smoke:

```sh
INTEGRATION=1 CODELIA_DEEPSEEK_LIVE=1 bun test packages/runtime/tests/deepseek-live.test.ts
```

This performs chargeable API requests and does not modify saved auth or config.
Ordinary tests skip it even if an API key exists.

## Sources

- [Models, version mapping and limits](https://api-docs.deepseek.com/quick_start/pricing/)
- [Responses compatibility and replay](https://api-docs.deepseek.com/guides/responses_api/)
- [Thinking effort mapping](https://api-docs.deepseek.com/guides/thinking_mode/)
- [API-key authentication](https://api-docs.deepseek.com/api/deepseek-api/)

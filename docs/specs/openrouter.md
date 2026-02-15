# OpenRouter Provider Spec

This document defines how codelia integrates OpenRouter as a runtime provider.

## 0. Implementation status (as of 2026-02-15)

Implemented:
- `openrouter` provider wiring in runtime auth/provider selection.
- Run execution via OpenRouter base URL using OpenAI-compatible Responses path (`ChatOpenAI` reuse).
- `model.list(provider=openrouter)` via OpenRouter `GET /models`.
- `model.set(provider=openrouter)` pass-through support for model IDs.
- Compaction remains enabled; provider-qualified model IDs (`provider/model`) are resolved with fallback logic.

Planned:
- Optional dedicated OpenRouter connector if API-delta handling is needed.
- Expanded routing/provider preference config fields beyond MVP.

## 1. Goals

- Add OpenRouter with minimal architecture changes and no provider/view coupling regressions.
- Keep Agent loop provider-agnostic by reusing existing `BaseChatModel` contract.
- Fail fast on provider config/auth mismatches (type/runtime guardrails).
- Preserve current OpenAI/Anthropic behavior.

## 2. Non-goals (initial phase)

- Full support for all OpenRouter-specific fields in MVP (provider routing, plugins, transforms, etc.).
- Management API coverage (`/keys`, `/auth/keys`, guardrails APIs).
- Separate protocol package release cadence from TUI/runtime (monorepo remains unified).

## 3. OpenRouter API baseline

Verified from OpenRouter OpenAPI (2026-02-15):

- OpenAPI spec:
  - `https://openrouter.ai/openapi.json`
  - `https://openrouter.ai/openapi.yaml`
- Server base URL: `https://openrouter.ai/api/v1`
- Auth: bearer token (`Authorization: Bearer <OPENROUTER_API_KEY>`)
- Primary generation endpoints:
  - `POST /responses`
  - `POST /chat/completions`
- Model metadata endpoint:
  - `GET /models`
- Key/account info endpoint:
  - `GET /key`
- Optional ranking headers:
  - `HTTP-Referer`
  - `X-Title`

Notable schema facts:
- Both `/responses` and `/chat/completions` support `application/json` and `text/event-stream`.
- `provider` routing object supports fields such as `allow_fallbacks`, `order`, `only`, `ignore`, `require_parameters`, `max_price`.
- Chat finish reason enum includes: `tool_calls`, `stop`, `length`, `content_filter`, `error`.
- Usage schema may include cost information (not only tokens), especially in Responses usage.

## 4. Integration strategy

### 4.1 Provider identity

- Add `openrouter` to runtime-supported providers:
  - `packages/runtime/src/auth/resolver.ts`
  - `packages/runtime/src/agent-factory.ts`
  - `packages/runtime/src/rpc/model.ts`
- Keep core provider union unchanged for now and route OpenRouter through OpenAI-compatible adapter path.

### 4.2 Model invocation path

MVP decision:
- Reuse existing `ChatOpenAI` implementation with OpenRouter base URL.
- Target OpenRouter `POST /responses` first (current codelia OpenAI path already uses Responses API and tool serialization).

Rationale:
- Lowest implementation risk (no duplicate serializer stack).
- Preserves multimodal/tool-call behavior already validated in current runtime flow.

Fallback strategy (phase 2+):
- Add dedicated `ChatOpenRouter` adapter only if OpenRouter-specific request/response handling diverges from current `ChatOpenAI` assumptions.
- Consider explicit fallback to `/chat/completions` only if needed by model/provider compatibility gaps.

### 4.3 Auth/headers

- Auth method: `api_key` only.
- Add env fallback key: `OPENROUTER_API_KEY`.
- `auth.json` provider entry:
  - `providers.openrouter.method = "api_key"`
  - `providers.openrouter.api_key = "..."`
- Optional app identification headers:
  - `HTTP-Referer`
  - `X-Title`

Header source policy (MVP):
- If configured, send both headers for OpenRouter requests.
- If not configured, proceed without them.

## 5. Config surface

### 5.1 Required

- `model.provider: "openrouter"`
- `model.name: string` (recommended canonical OpenRouter model id such as `author/slug`)

### 5.2 Optional (MVP)

- App headers via env or config (exact storage key finalized at implementation):
  - `OPENROUTER_HTTP_REFERER`
  - `OPENROUTER_X_TITLE`

### 5.3 Optional (phase 2)

- Request-time routing fields, for example:
  - `provider.allow_fallbacks`
  - `provider.order`
  - `provider.only`
  - `provider.ignore`
  - `provider.require_parameters`
  - `provider.max_price`

## 6. Model list/set behavior

MVP behavior:
- `model.list(provider=openrouter)` should return model ids from `GET /models` (prefer API truth over static registry).
- Preserve current `model.list` result shape (`provider`, `models`, optional `details`).
- `model.set` for `openrouter` should accept:
  - IDs returned by `model.list`, and
  - pass-through arbitrary model IDs (to avoid breakage when new models appear before cache refresh).

Future enhancement:
- Add short TTL cache for `/models`.
- Surface selected model metadata (context, pricing, capabilities) in `details`.

## 7. Error handling and retry normalization

Map OpenRouter HTTP errors into existing runtime error categories:

- `401`: auth error (missing/invalid key)
- `402`: insufficient credits/payment required (non-retryable by default)
- `429`: rate limit (retryable with backoff)
- `5xx`/`52x`: provider transient error (retryable)

Additional policy:
- Keep upstream error body snippets in debug logs only (`CODELIA_DEBUG=1` path).
- Do not leak secrets in logs/UI.

## 8. Testing plan

Unit tests:
- Auth resolver:
  - `openrouter` provider selection and API-key prompt flow.
  - env fallback (`OPENROUTER_API_KEY`).
- Agent factory:
  - `openrouter` branch builds client options with base URL + optional headers.
- Model RPC:
  - `model.list` and `model.set` behavior for dynamic OpenRouter models.

Integration tests (opt-in):
- Gate with `INTEGRATION=1`, `OPENROUTER_API_KEY`, and `CODELIA_TEST_OPENROUTER_MODEL`.
- Verify:
  - basic text run
  - tool call round-trip
  - stream completion path

Regression checks:
- Existing OpenAI/Anthropic tests must remain green.

## 9. Rollout phases

1. Provider wiring + auth support + run execution using `/responses`.
2. Dynamic model listing via `/models` + onboarding support.
3. Optional OpenRouter routing/provider-preference config.
4. Optional dedicated OpenRouter adapter if API-delta handling becomes necessary.

## 10. References

- OpenRouter API overview: `https://openrouter.ai/docs/api/reference/overview`
- OpenRouter authentication docs: `https://openrouter.ai/docs/api/reference/authentication`
- OpenRouter provider routing docs: `https://openrouter.ai/docs/guides/routing/provider-selection`
- OpenRouter limits/key docs: `https://openrouter.ai/docs/api/reference/limits`
- OpenRouter OpenAPI JSON: `https://openrouter.ai/openapi.json`

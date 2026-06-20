# Z.ai Native Provider Spec

Status: Implemented
Date: 2026-06-20
Related:
- `dev-docs/specs/providers.md`
- `dev-docs/specs/model-parameter-ui.md`
- `dev-docs/specs/model-metadata.md`
- `packages/core/src/llm/base.ts`
- `packages/runtime/src/agent-factory.ts`
- `packages/runtime/src/auth/resolver.ts`
- `packages/runtime/src/rpc/model.ts`

Implemented in phase 1:

- Core provider adapter: `packages/core/src/llm/zai/`
- Z.ai HTTP/SSE transport helpers: `packages/core/src/llm/zai/transport.ts`
- Static model spec: `packages/core/src/models/zai.ts`
- Runtime auth/model/onboarding/agent-factory wiring for `model.provider=zai`
- TUI `/model` provider selection includes `zai`

Still intentionally deferred:

- dynamic Z.ai model-list fetching
- Z.ai hosted/native web search
- opt-in live integration smoke tests

## 1. Goal

Add a native `zai` provider for Z.ai GLM-5.2 without routing through OpenRouter.

The native provider should preserve Codelia's provider-neutral agent loop while adapting Z.ai's Chat Completions API into the existing `BaseChatModel` contract:

- `BaseMessage[]` in
- provider-specific request out
- provider-specific response back into `ChatInvokeCompletion`
- normalized assistant text, reasoning, tool calls, usage, and provider metadata

## 2. Current Implementation Findings

### 2.1 Provider identity is split across core and runtime

Core currently defines:

- `ProviderName = "openai" | "anthropic" | "openrouter" | "google"` in `packages/core/src/llm/base.ts`
- `HostedSearchToolDefinition.provider` with the same provider union in `packages/core/src/types/llm/tools.ts`
- model registry alias buckets for `openai`, `anthropic`, `openrouter`, and `google` in `packages/core/src/models/registry.ts`
- provider filters in `applyModelMetadata()` that ignore provider ids outside that set
- provider-qualified model parsing in `packages/core/src/agent/agent.ts` and `packages/core/src/services/compaction/service.ts`

Runtime separately defines:

- `SUPPORTED_PROVIDERS = ["openai", "anthropic", "openrouter"]` in `packages/runtime/src/auth/resolver.ts`
- `SupportedModelProvider = "openai" | "anthropic" | "openrouter"` in `packages/runtime/src/rpc/model.ts`
- `agent-factory` provider construction for `ChatOpenAI`, `ChatOpenRouter`, and `ChatAnthropic`

Adding only a core `ProviderName` entry is not enough. Runtime auth, model RPC, model registry construction, and onboarding must also accept `zai`.

### 2.2 Existing provider adapters are provider-owned

The implemented providers follow this split:

- `ChatOpenAI`: core adapter, OpenAI Responses API
- `ChatOpenRouter`: core adapter, OpenRouter Responses API
- `ChatAnthropic`: core adapter, Anthropic Messages API
- runtime: chooses provider, resolves auth/config, constructs the adapter

OpenRouter's connector split is the right precedent: provider invocation belongs in `@codelia/core`, while runtime owns auth, model config, onboarding, and model listing.

### 2.3 The OpenAI/OpenRouter path is Responses-specific

`ChatOpenAI` and `ChatOpenRouter` use OpenAI SDK Responses APIs and serialize history as Responses input items. That path depends on Responses concepts such as `response.output`, `function_call_output`, `reasoning.encrypted_content`, `response.output_text`, and `responses.stream(...).finalResponse()`.

Z.ai native integration should not reuse `ChatOpenAI` or `ChatOpenRouter` with a base URL change. Z.ai's documented generation endpoint is Chat Completions, not Responses.

### 2.4 The common message model is sufficient

Current core types already have the escape hatches needed for Z.ai:

- `AssistantMessage.content` for final text
- `AssistantMessage.tool_calls` for function calls
- `ReasoningMessage.content` plus `raw_item` for `reasoning_content`
- `ToolCall.provider_meta` for preserving compact provider call metadata needed for replay/debug
- `ChatInvokeUsage` for token usage
- `ChatInvokeCompletion.provider_meta` for response id, request id, finish reason, and reasoning mapping metadata

The agent loop already emits reasoning events from `ReasoningMessage`, continues based on assistant tool calls, and records `llm.request` / `llm.response` provider metadata.

### 2.5 Static model metadata is required for reliable startup

`buildModelRegistry()` refreshes models.dev metadata, then falls back to `DEFAULT_MODEL_REGISTRY`. In strict mode, startup fails if the selected model has neither fetched metadata nor a usable static `ModelSpec` with a positive context budget.

Because models.dev coverage for `zai` may lag or use a different provider id, `glm-5.2` must be added as a usable static model spec.

## 3. Z.ai API Facts

Verified against Z.ai developer docs on 2026-06-20:

- Auth: `Authorization: Bearer <token>`
- Endpoint: `POST https://api.z.ai/api/paas/v4/chat/completions`
- Model id: `glm-5.2`
- Context length: 1M
- Maximum output tokens: 128K / `max_tokens <= 131072`
- Streaming: `stream=true`
- Streaming tool call arguments: `tool_stream=true`
- Reasoning stream field: `delta.reasoning_content`
- Final message reasoning field: `choices[].message.reasoning_content`
- Tool calls: `choices[].message.tool_calls` and streaming `delta.tool_calls`
- Thinking control: `thinking: { type: "enabled" | "disabled" }`
- Reasoning effort values: `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, `none`
- Z.ai maps `low` / `medium` to `high`, and `xhigh` to `max`

References:

- `https://docs.z.ai/api-reference/llm/chat-completion`
- `https://docs.z.ai/guides/llm/glm-5.2`
- `https://docs.z.ai/guides/overview/migrate-to-glm-new`
- `https://docs.z.ai/guides/capabilities/thinking`
- `https://docs.z.ai/guides/overview/concept-param`

## 4. Target Architecture

### 4.1 Core

Add `packages/core/src/llm/zai/`:

- `chat.ts`: `ChatZai implements BaseChatModel<"zai", ZaiInvokeOptions>`
- `serializer.ts`: provider-neutral message/tool conversion and completion normalization
- optional small transport/parser helpers if streaming code grows
- focused unit tests under `packages/core/tests/`

Export `ChatZai` from `packages/core/src/index.ts`.

Add `packages/core/src/models/zai.ts` with:

```ts
export const ZAI_DEFAULT_MODEL = "glm-5.2";

export const ZAI_MODELS = [
  {
    id: "glm-5.2",
    provider: "zai",
    aliases: ["default"],
    contextWindow: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 131_072,
    supportsTools: true,
    supportsReasoning: true,
    supportsJsonSchema: true,
  },
];
```

Add `zai` to:

- `ProviderName`
- model registry alias buckets and clone helpers
- `applyModelMetadata()` provider allowlist
- provider-qualified model parsing in agent/compaction/tool-output-cache paths
- hosted-search provider union only if there is a concrete Z.ai hosted-search adapter; otherwise leave native search unsupported in phase 1

### 4.2 Runtime

Add `zai` to:

- auth provider selection and onboarding
- `API_KEY_ENV` as `ZAI_API_KEY`
- API-key prompt label (`Z.ai API key`)
- model RPC supported provider union
- `model.list` / `model.set`
- `createAgentFactory` provider switch

Add runtime client option builder:

- default base URL: `https://api.z.ai/api/paas/v4`
- env override: `ZAI_BASE_URL`
- auth: `ZAI_API_KEY` or saved `auth.json` api key
- request timeout: `ChatZai` defaults to 20 minutes and can be disabled/overridden in tests or direct construction with `timeoutMs`

Model listing phase 1 should use static registry. Do not add a dynamic Z.ai model-list fetch unless Z.ai exposes a stable model-list endpoint and the expected response shape is confirmed.

### 4.3 Protocol and config

No protocol shape change is required. `model.provider` and model RPC provider fields are strings today.

No config schema migration is required. Existing `model.reasoning` remains the only user-facing reasoning knob.

## 5. Request Mapping

### 5.1 Messages

Map Codelia messages to Chat Completions messages:

- `system` -> `{ role: "system", content: string }`
- `user` -> `{ role: "user", content: string | provider-supported content parts }`
- `assistant` text -> `{ role: "assistant", content }`
- `assistant.tool_calls` -> assistant message with `tool_calls`
- `tool` -> `{ role: "tool", tool_call_id, content }`
- `reasoning` -> omit on replay in phase 1

Phase 1 should treat multimodal parts conservatively:

- text parts are preserved
- images/documents are degraded to placeholders unless Z.ai multimodal input is explicitly implemented and tested
- provider-specific `other` parts are replayed only if `provider === "zai"` and the payload shape is known safe; otherwise stringify/degrade

### 5.2 Tools

Map Codelia function tools to OpenAI-style Chat Completions tools:

```ts
{
  type: "function",
  function: {
    name,
    description,
    parameters
  }
}
```

Initial policy:

- support function tools
- set `tool_choice` for `auto`, `required`, `none`, or a specific tool name
- enable `tool_stream: true` whenever tools are present and `stream: true`
- ignore hosted search tools for `zai` in phase 1
- preserve compact provider call metadata in `ToolCall.provider_meta`; do not persist raw streaming chunks in history/session snapshots

### 5.3 Reasoning

Keep Codelia's canonical config values:

- `low`
- `medium`
- `high`
- `xhigh`

Map to Z.ai request values:

- `low` -> `high`
- `medium` -> `high`
- `high` -> `high`
- `xhigh` -> `max`

Always send `thinking: { type: "enabled" }` in phase 1. Record both requested and applied canonical levels in `provider_meta`:

- requested: Codelia level
- applied: `high` for `low|medium|high`, `xhigh` for `xhigh`
- provider reasoning effort: `high` or `max`
- fallbackApplied: true when requested was `low` or `medium`

Do not expose `minimal`, `none`, or raw Z.ai `thinking` settings in the baseline UI in phase 1.

`sessionKey` is intentionally unused in phase 1 because Z.ai has no confirmed
OpenAI `prompt_cache_key` equivalent. Do not invent provider headers until the
contract is documented and tested.

## 6. Streaming and Completion Normalization

Implement streaming as the default invocation path to match existing OpenAI/OpenRouter behavior.

The stream accumulator should collect:

- text deltas from `choices[0].delta.content`
- reasoning deltas from `choices[0].delta.reasoning_content`
- tool call name/id/type/function argument deltas from `choices[0].delta.tool_calls`
- finish reason from the terminal chunk
- usage if supplied by Z.ai

Return `ChatInvokeCompletion.messages` in provider event order as far as practical:

1. reasoning message if reasoning text exists
2. assistant text message if content exists
3. assistant tool-call message if tool calls exist

If Z.ai returns text and tool calls in the same assistant turn, preserve both rather than dropping text. Existing agent code can handle an assistant message with text plus `tool_calls`, and existing compaction already strips risky dangling tool calls during history rewriting.

## 7. Usage, Diagnostics, and Error Handling

Normalize usage into `ChatInvokeUsage`:

- `model`
- `input_tokens`
- `output_tokens`
- `total_tokens`

If Z.ai provides cached-token fields later, add them only after confirming names.

`max_tokens` is supported as a per-invoke `ZaiInvokeOptions` field, but runtime
does not set a default in phase 1. This leaves Z.ai's server default in effect
until Codelia chooses an explicit cost-safety cap.

Provider diagnostics should follow existing provider-log conventions:

- `CODELIA_PROVIDER_LOG=1` emits one-line request/response summaries
- `CODELIA_PROVIDER_LOG_DIR` writes request/response dumps
- never log API keys
- log provider as `zai`

HTTP error policy:

- `401`/`403`: auth/config error
- `402`: credits/payment error, non-retryable
- `408`/`429`/`5xx`: transient or rate-limit class; surface status and a bounded body snippet
- malformed stream: provider error with enough chunk context in debug logs, not in normal UI

## 8. Model Listing and Selection

Phase 1:

- `model.list(provider=zai)` returns static usable Z.ai models from `DEFAULT_MODEL_REGISTRY`
- `model.set(provider=zai, name=glm-5.2)` validates against static registry
- onboarding can pick `zai`, prompt for API key, then pick `glm-5.2`

Do not accept arbitrary `zai` model names in phase 1. That keeps compaction and context-left behavior tied to known limits.

## 9. Search Behavior

`search.mode=auto` should not expose provider-native search for `zai` in phase 1.

Runtime should fall back to local `search` for `zai`, the same way it does for providers without native hosted search support.

Z.ai web search or retrieval tools can be evaluated later as a separate feature because their request/response contracts are not the same as Codelia's function tool loop.

## 10. Testing Plan

Core unit tests:

- provider identity and default model
- text-only streaming response
- reasoning-only + text response normalization
- tool-call streaming with argument concatenation
- assistant text plus tool call in one response
- replay serialization for assistant tool call followed by tool result
- hosted search is ignored for `zai`
- usage normalization
- provider log request/response summaries do not include secrets
- raw stream chunks are counted but not retained by the default accumulator;
  full raw chunks are captured only for explicit provider dump output

Runtime unit tests:

- `ZAI_API_KEY` env auth
- onboarding provider pick includes `zai`
- model list returns `glm-5.2` with details
- model set accepts `provider=zai, name=glm-5.2`
- agent factory constructs `ChatZai`
- `search.mode=auto` uses local search for `zai`
- reasoning mapping tests for `low|medium|high|xhigh`

Integration tests, opt-in only:

- gated by `INTEGRATION=1`, `ZAI_API_KEY`, and `CODELIA_TEST_ZAI_MODEL`
- text smoke
- tool round trip
- reasoning stream smoke

Suggested focused verification commands:

```sh
bun test packages/core/tests/zai-chat.test.ts packages/core/tests/zai-tools-serializer.test.ts
bun test packages/runtime/tests/model-zai.test.ts packages/runtime/tests/startup-onboarding.test.ts packages/runtime/tests/model-reasoning.test.ts
bun run typecheck
```

## 11. Rollout Phases

1. Land spec and implementation plan.
2. Add core `zai` provider types, model spec, serializer, and `ChatZai`.
3. Add runtime auth, model RPC, model registry, and agent-factory wiring.
4. Add focused unit tests.
5. Add optional integration smoke.
6. Update local AGENTS notes after implementation is complete.

## 12. Open Questions

- Does Z.ai provide usage in streaming terminal chunks consistently, or is a non-stream fallback needed to guarantee usage?
- What explicit `max_tokens` default should Codelia use if it decides not to rely on Z.ai's server default?
- Should `ZAI_BASE_URL` support the coding endpoint `https://api.z.ai/api/coding/paas/v4` as a separate env override only, or should it become config?
- Does Z.ai require special handling for strict JSON schema subsets beyond function parameter JSON Schema?
- Are Z.ai tool call ids stable enough to replay directly as `tool_call_id`, or should Codelia generate fallback ids when missing?

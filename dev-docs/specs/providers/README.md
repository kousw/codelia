# Providers Spec（OpenAI / Anthropic / Gemini / DeepSeek / OpenRouter / Moonshot / Z.ai / xAI）

This document is a specification that aligns providers (OpenAI / Anthropic / Gemini / DeepSeek / OpenRouter / Moonshot / Z.ai / xAI) into a "common interface".
The goal is to make the Agent loop unaware of provider differences.

Implementation status (as of 2026-11-28):
- Implemented connectors: OpenAI (`ChatOpenAI`), Anthropic (`ChatAnthropic`), OpenRouter (`ChatOpenRouter`), Google (`ChatGoogle`), DeepSeek (`ChatDeepSeek`), Moonshot (`ChatMoonshot`), Z.ai (`ChatZai`), xAI (`ChatXai`), plus configured named HTTP Responses endpoints (`ChatResponses`).
- Configured named HTTP Responses endpoints: [Named Responses endpoints](./responses-endpoints.md).
- DeepSeek uses stateless Responses with API-key auth; only Flash and V4-Pro are registered. See [DeepSeek provider](./deepseek-provider.md).
- Google Interactions chat/function calling and custom image adapters are fixture-tested and partially live verified; see [Google provider contract](./google-provider.md).
- OpenRouter behavior details: [OpenRouter provider](./openrouter.md) (archived connector split notes in [`../../archive/openrouter-core-connector.md`](../../archive/openrouter-core-connector.md)).
- Anthropic Sonnet/Haiku 5.5 contracts and signed replay: [Anthropic provider](./anthropic-provider.md).
- Moonshot implementation details: [Moonshot provider](./moonshot-provider.md).
- Z.ai implementation details: [Z.ai provider](./zai-provider.md).
- xAI implementation details: [xAI provider](./xai-provider.md).
- Existing Codex OAuth metadata compatibility: [selected metadata contracts](./codex-backend-metadata.md).
- Image support is separate from chat connectors: [image provider matrix and Codex research](./image-generation.md), with the implemented public OpenAI/OpenRouter API subset in [section 1.1](../image-generation.md#11-implemented-public-api-slice) and existing-login Codex OAuth builtin in [section 1.2](../image-generation.md#12-implemented-codex-oauth-builtin). Other connectors and hosted/native image output are not implied by this inventory.

---

## 1. BaseChatModel (common interface)

```ts
export interface BaseChatModel<P = ProviderName, O = unknown> {
  readonly provider: P;
  readonly model: string;

  ainvoke(input: {
    messages: BaseMessage[];
    model?: string;
    tools?: ToolDefinition[] | null;
    toolChoice?: ToolChoice | null;
    signal?: AbortSignal;
    options?: O; // provider-specific options
  }): Promise<ChatInvokeCompletion>;
}
```

---

## 2. Serializer layer (responsibility)

The Connector (provider implementation) is responsible for:

- `BaseMessage[]` → Convert to message format required by SDK
- `ToolDefinition[]` → Convert to tool format required by SDK
- Return value → normalized to `ChatInvokeCompletion`
- If provider-specific information (such as Gemini's function call signature) is required, store it in `ToolCall.provider_meta`

Note:
- If `ToolMessage.trimmed=true`, send **placeholder** (do not send entity)

---

## 2.1 OpenAI（Responses API）

OpenAI uses the Responses API instead of Chat Completions.

- `BaseMessage[]` is converted to input items of `responses.create({ input: [...] })`
- `ContentPart` of `user`/`tool` message is converted to `input_text` / `input_image` / `input_file`
- `assistant` message is sent as `output_text` / `refusal` for restore compatibility
- tool is converted to `type: "function"` and tool_choice is given as necessary
- tool result returns `function_call_output` (links id of tool call)

## 3. Tool schema mode

### 3.1 Built-in tools

Built-in tools created with `defineTool` explicitly use non-strict function
calling. Their model-facing JSON Schema preserves Zod optional/defaulted fields
as optional instead of expanding every property into a nullable required field.
Runtime Zod parsing still validates every tool call before execution.

This keeps the schema compact and avoids requiring models to emit null/default
arguments that have no behavioral effect.

### 3.2 External schemas

Client-provided tools may set `strict` explicitly, and MCP tools remain
non-strict. A caller choosing strict mode is responsible for supplying a
provider-compatible schema, including required properties and nullable optional
semantics where the provider requires them. Provider serializers preserve the
requested strict flag; they do not rewrite shared tool schemas.

### 3.3 Anthropic / Gemini / DeepSeek / OpenRouter / Moonshot / Z.ai / xAI

- Anthropic (Implemented): convert to Anthropic SDK tool format and preserve tool error semantics.
- Gemini (Implemented): convert to Interactions function steps and preserve signed thought/call metadata for stateless replay.
- DeepSeek (Implemented): stateless HTTP Responses with function calling and plaintext reasoning/tool replay.
- OpenRouter (Implemented): dedicated connector on Responses API path; provider-specific behavior is allowed on top of the shared Responses baseline.
- Moonshot (Implemented): OpenAI-compatible Chat Completions connector (`kimi-k3` max-only and `kimi-k3.1-pro*` `low`/`high`/`max`); preserves `reasoning_content` on assistant replay.
- Z.ai (Implemented): native Chat Completions connector with provider-specific tool and reasoning serialization.
- xAI (Implemented): Responses API connector (`grok-4.5`, `grok-4.7`) with encrypted reasoning replay, image input, prompt-cache affinity, and xAI native web/X search.

---

## 4. reasoning / redacted reasoning

Implemented:
- reasoning normalizes to `ReasoningMessage` within `ChatInvokeCompletion.messages`
- `runStream` generates `ReasoningEvent` from `ReasoningMessage`

Planned:
- Dedicated field for `redacted_reasoning` has not been introduced (type extension when necessary)

---

## 5. Usage normalization

usage is normalized to `ChatInvokeUsage`. Provider difference:

- OpenAI: prompt/ completion/ total + cached tokens (if any)
- Anthropic: has cache creation / cache read
- Gemini: May have image tokens

If usage cannot be obtained, allow `null`, and compaction should be “do nothing if there is no usage” (but take it if possible).

Provider additions and transport migrations must verify normalized usage and
observed timing together through runtime `buildRunMetrics`, covering reasoning
and tool-only turns. Extend `packages/runtime/tests/provider-metrics.test.ts` or
the provider-specific metrics fixtures. Start the monotonic tracker before
transport setup, record provider-specific reasoning activity separately from
first-output latency, freeze on terminal completion, and isolate attempts.
Missing usage or unobservable generation must remain unavailable; never infer
tokens from text/chunks or substitute total request latency. See
[diagnostics section 4.2](../llm-call-diagnostics.md#42-observed-streaming-generation-rate-implemented).

---

## 6. Error normalization (for retry)

Implemented (`packages/core/src/llm/failures.ts`, `packages/core/src/llm/retry.ts`):
- Every built-in provider and `ChatResponses` exposes a pure `classifyFailure` mapping errors to `ProviderFailure` (`ProviderFailureError` / `ProviderTimeoutError`) across `auth`, `permission`, `hard_quota`, `rate_limit`, `overloaded`, `timeout`, `network`, `validation`, `provider`, and `cancelled`.
- `Agent.runStream()` owns bounded retry windows (`retry.ts`) with SDK retries disabled; UI/session consumers receive only redacted structured fields (`RunErrorInfo` / `llm.retry`), never raw SDK exception stacks or credentials.
- See [`retry-and-failures.md`](./retry-and-failures.md) for per-provider classification rules and remaining transport-watchdog work.

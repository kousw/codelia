# Providers Spec（OpenAI / Anthropic / Gemini / OpenRouter）

This document is a specification that aligns providers (OpenAI / Anthropic / Gemini / OpenRouter) into a "common interface".
The goal is to make the Agent loop unaware of provider differences.

Implementation status (as of 2026-02-15):
- Implemented connector: OpenAI (`ChatOpenAI`), Anthropic (`ChatAnthropic`)
- Implemented runtime path: OpenRouter via OpenAI-compatible Responses path (shared `ChatOpenAI` adapter with OpenRouter base URL).
- Partial groundwork for Gemini/Google: `ProviderName` includes `google` and model snapshots exist.
- Planned connector: Gemini/Google chat connector (`ChatGoogle`) is not implemented yet.
- Planned connector: dedicated OpenRouter connector (if API-delta handling is needed). See `docs/specs/openrouter.md`.

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

Compatibility notes:
- The Python version defines `BaseChatModel` as Protocol, and each provider accesses the API via serializer.

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

## 3. Tool schema and strict compatibility

### 3.1 OpenAI strict

The Python version makes adjustments such as ``make required all properties'' when strict.

The TS version is equally compatible:

- Convert tool JSON Schema if necessary to be consistent with “strict tool calling”
- Adjust according to provider specifications, such as treating optional fields as “nullable”

The specific conversion is the responsibility of the provider side (the tools side maintains provider-agnostic).

### 3.2 Anthropic / Gemini / OpenRouter

- Anthropic (Implemented): convert to Anthropic SDK tool format and preserve tool error semantics.
- Gemini (Planned): convert to Gemini SDK tool format and carry provider-specific call metadata as needed.
- OpenRouter (Partial): currently uses OpenAI-compatible Responses path; add dedicated connector only when divergence requires it.

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

---

## 6. Error normalization (for retry)

To avoid the need for the Agent to absorb “differences in exception types”, it is recommended to normalize the following at the provider layer:

- `ModelRateLimitError(statusCode?)`
- `ModelProviderError(statusCode?)`

Furthermore, timeout / connection error should also be wrapped in these, or at least given a message that can be determined.

---

## 7. Order of implementation while learning (recommended)

1. Secure the Agent loop with `MockModel` (return assistant message + `tool_calls`)
2. Implement OpenAI connector (initially the minimum “tool calling can go back and forth”)
3. Anthropic connector (absorbs serialization difference of tool result)
4. Gemini connector (function call difference, keep signature if necessary)

This order allows you to understand the differences step by step.

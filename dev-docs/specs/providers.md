# Providers Spec（OpenAI / Anthropic / Gemini / OpenRouter / Moonshot / Z.ai）

This document is a specification that aligns providers (OpenAI / Anthropic / Gemini / OpenRouter / Moonshot / Z.ai) into a "common interface".
The goal is to make the Agent loop unaware of provider differences.

Implementation status (as of 2026-07-17):
- Implemented connector: OpenAI (`ChatOpenAI`), Anthropic (`ChatAnthropic`), OpenRouter (`ChatOpenRouter`), Moonshot (`ChatMoonshot`), Z.ai (`ChatZai`)
- Partial groundwork for Gemini/Google: `ProviderName` includes `google` and model snapshots exist.
- Planned connector: Gemini/Google chat connector (`ChatGoogle`) is not implemented yet.
- OpenRouter behavior details: `dev-docs/specs/openrouter.md`, split notes in `dev-docs/specs/openrouter-core-connector.md`.
- Moonshot implementation details: `dev-docs/specs/moonshot-provider.md`.
- Z.ai implementation details: `dev-docs/specs/zai-provider.md`.

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

### 3.3 Anthropic / Gemini / OpenRouter / Moonshot / Z.ai

- Anthropic (Implemented): convert to Anthropic SDK tool format and preserve tool error semantics.
- Gemini (Planned): convert to Gemini SDK tool format and carry provider-specific call metadata as needed.
- OpenRouter (Implemented): dedicated connector on Responses API path; provider-specific behavior is allowed on top of the shared Responses baseline.
- Moonshot (Implemented): OpenAI-compatible Chat Completions connector for Kimi K3; preserves `reasoning_content` on assistant replay and maps canonical reasoning to the only currently supported `max` effort.
- Z.ai (Implemented): native Chat Completions connector with provider-specific tool and reasoning serialization.

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

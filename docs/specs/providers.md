# Providers Spec（OpenAI / Anthropic / Gemini）

この文書は 3 プロバイダ（OpenAI / Anthropic / Gemini）を「共通インタフェース」に揃える仕様です。
目標は “Agent ループがプロバイダ差分を意識しない” ことです。

---

## 1. BaseChatModel（共通インタフェース）

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

互換メモ:
- Python版は `BaseChatModel` を Protocol として定義し、各プロバイダは serializer を介して API を叩く。

---

## 2. Serializer 層（責務）

Connector（プロバイダ実装）は次を担当する:

- `BaseMessage[]` → SDK が要求する message 形式に変換
- `ToolDefinition[]` → SDK が要求する tool 形式に変換
- 返り値 → `ChatInvokeCompletion` に正規化
- プロバイダ固有の付帯情報（Gemini の function call signature 等）が必要なら `ToolCall.provider_meta` に保持

注意:
- `ToolMessage.trimmed=true` の場合は **placeholder** を送る（実体を送らない）

---

## 2.1 OpenAI（Responses API）

OpenAI は **Chat Completions ではなく Responses API** を使う。

- `BaseMessage[]` は `responses.create({ input: [...] })` の input items に変換
- `user`/`tool` message の `ContentPart` は `input_text` / `input_image` / `input_file` に変換
- `assistant` message は restore 互換のため `output_text` / `refusal` で送る
- tool は `type: "function"` に変換し、tool_choice を必要に応じて付与
- tool result は `function_call_output` を返す（tool call の id を紐付ける）

## 3. Tool schema と strict 互換

### 3.1 OpenAI strict

Python版は strict 時に「required を全プロパティにする」等の調整を行う。

TS版も同等の互換を持つ:

- tool の JSON Schema が “strict tool calling” と整合するよう、必要なら変換する
- optional フィールドは “nullable” 扱いにするなど、プロバイダ仕様に合わせて調整する

具体的な変換は provider 側の責務に寄せる（tools 側は provider-agnostic を維持）。

### 3.2 Anthropic / Gemini

- それぞれの SDK が要求する tool 定義の形に変換する
- tool result の “error flag” をネイティブに渡せる場合は活用する

---

## 4. reasoning / redacted reasoning

Implemented:
- reasoning は `ChatInvokeCompletion.messages` 内の `ReasoningMessage` に正規化する
- `runStream` は `ReasoningMessage` から `ReasoningEvent` を生成する

Planned:
- `redacted_reasoning` の専用フィールドは未導入（必要時に型拡張）

---

## 5. Usage 正規化

usage は `ChatInvokeUsage` に正規化する。プロバイダ差分:

- OpenAI: prompt/ completion/ total + cached tokens（あれば）
- Anthropic: cache creation / cache read を持つ
- Gemini: image tokens を持つ場合がある

usage が取れない場合は `null` を許容し、compaction は “usage無しなら何もしない” で良い（ただしできれば取る）。

---

## 6. エラー正規化（retry のため）

Agent が “例外型の違い” を吸収しなくて済むよう、provider 層で以下に正規化するのが推奨:

- `ModelRateLimitError(statusCode?)`
- `ModelProviderError(statusCode?)`

さらに timeout / connection error もこれらに包むか、少なくとも判定できる message を付与する。

---

## 7. 学びながら実装する順序（推奨）

1. `MockModel`（assistant message + `tool_calls` を返す）で Agent ループを固める
2. OpenAI connector を実装（最初は “tool calling が往復できる” 最小）
3. Anthropic connector（tool result のシリアライズ差分を吸収）
4. Gemini connector（function call の差分、必要なら signature を保持）

この順序だと差分が段階的に理解できる。

# Core Types Spec（共通型・互換性）

この文書は TypeScript 版 Agent SDK の「共通型（コアが扱うデータ形状）」を定義します。

目的は 2 つです。

1. Agent ループが **プロバイダ差分に影響されない**ようにする
2. Tool / Message / Usage / Events を **テスト可能**かつ **拡張可能**にする

---

## 1. 互換性の基本方針

- コア（Agent）は「共通型」だけを見る
- OpenAI / Anthropic / Gemini の差分は `providers/*` が吸収する
- 返り値・履歴に残す形は、将来の追加フィールドを許容する（`meta?: unknown` 等）

実装上の配置:
- `packages/core/src/types/llm/*`（messages / tools / invoke）
- `packages/core/src/types/events/*`（AgentEvent）

---

## 2. Message 型

### 2.1 Role

```ts
export type Role = 'system' | 'user' | 'assistant' | 'tool';
```

### 2.2 Content Parts（マルチモーダル）

Tool 結果やユーザー入力が「テキスト + 画像」等になり得るため、content は string か parts 配列を許容します。

```ts
export type TextPart = { type: 'text'; text: string };

export type ImagePart = {
  type: 'image_url';
  image_url: {
    url: string;              // data URL か https URL
    detail?: 'auto' | 'low' | 'high';
    media_type?: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  };
};

export type DocumentPart = {
  type: 'document';
  source: {
    data: string;             // base64
    media_type: 'application/pdf';
  };
};

export type ContentPart = TextPart | ImagePart | DocumentPart;
```

### 2.3 BaseMessage

```ts
export type UserMessage = {
  role: 'user';
  content: string | ContentPart[];
  name?: string;
};

export type SystemMessage = {
  role: 'system';
  content: string | TextPart[];
  name?: string;
  cache?: boolean;            // Anthropic などの prompt caching 用（対応プロバイダのみ有効）
};

export type AssistantMessage = {
  role: 'assistant';
  content: string | null;     // tool calls のみの場合は null も許容
  name?: string;
  tool_calls?: ToolCall[];
  refusal?: string | null;
};

export type ToolOutputRef = {
  id: string;
  byte_size?: number;
  line_count?: number;
};

export type ToolMessage = {
  role: 'tool';
  tool_call_id: string;
  tool_name: string;
  content: string | (TextPart | ImagePart)[]; // tool は document を返さない想定でも良い（必要なら拡張）
  is_error?: boolean;
  output_ref?: ToolOutputRef; // tool output cache 参照
  trimmed?: boolean;          // “内容がトリム済み”
};

export type BaseMessage =
  | UserMessage
  | SystemMessage
  | AssistantMessage
  | ToolMessage;
```

メモ:
- `trimmed` の場合でも `output_ref` から展開できること。

---

## 3. Tool calls / Tool definitions

### 3.1 ToolCall

```ts
export type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;  // JSON string
  };
  provider_meta?: unknown;     // Gemini 等で必要な付帯情報があれば保持
};
```

### 3.2 ToolDefinition（LLM に渡す“道具”）

```ts
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JSONSchema7;     // json-schema の Draft-07 を採用（zod→変換）
  strict?: boolean;            // OpenAI strict を意識（true 推奨）
};
```

### 3.3 ToolChoice（LLM がどうツールを選ぶか）

```ts
export type ToolChoice = 'auto' | 'required' | 'none' | string; // string は tool name 強制
```

---

## 4. LLM 呼び出しの共通返り値

```ts
export type ChatInvokeUsage = {
  model: string;
  input_tokens: number;
  input_cached_tokens?: number | null;
  input_cache_creation_tokens?: number | null; // Anthropic only
  input_image_tokens?: number | null;          // Gemini only
  output_tokens: number;
  total_tokens: number;
};

export type ChatInvokeCompletion = {
  messages: BaseMessage[];        // normalized output sequence from provider
  usage?: ChatInvokeUsage | null;
  stop_reason?: string | null;    // end_turn / tool_use / max_tokens etc
  provider_meta?: unknown;        // provider-specific metadata
};
```

注意:
- Implemented: text/tool_calls/reasoning は `messages`（順序付き）で表現する
- Implemented: Agent は assistant message から抽出した `tool_calls` 数で継続判定する
- Planned: `redacted_reasoning` 専用フィールドは未導入（必要時に拡張）

---

## 5. Agent events（runStream 用）

UI/CLI が “今何をしているか” を表示できるよう、イベントは判別可能ユニオンにします。

```ts
export type TextEvent = { type: 'text'; content: string; timestamp: number };
export type ReasoningEvent = { type: 'reasoning'; content: string; timestamp: number };

export type StepStartEvent = {
  type: 'step_start';
  step_id: string;
  title: string;
  step_number: number;
};

export type ToolCallEvent = {
  type: 'tool_call';
  tool: string;
  args: Record<string, unknown>;
  tool_call_id: string;
  display_name?: string;
};

export type ToolResultEvent = {
  type: 'tool_result';
  tool: string;
  result: string;
  tool_call_id: string;
  is_error?: boolean;
  screenshot_base64?: string | null;
};

export type StepCompleteEvent = {
  type: 'step_complete';
  step_id: string;
  status: 'completed' | 'error';
  duration_ms: number;
};

export type HiddenUserMessageEvent = { type: 'hidden_user_message'; content: string };

export type FinalResponseEvent = { type: 'final'; content: string };

export type AgentEvent =
  | TextEvent
  | ReasoningEvent
  | StepStartEvent
  | ToolCallEvent
  | ToolResultEvent
  | StepCompleteEvent
  | HiddenUserMessageEvent
  | FinalResponseEvent;
```

互換メモ:
- Python版 `events.py` に準拠（UI向けに step start/complete を出す）
- token-by-token のストリームはコア要件ではない（必要なら provider で拡張）

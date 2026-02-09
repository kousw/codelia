# Agent Loop Spec（run / runStream・終了条件）

この文書は Agent の実行ループを定義します。
実装済みの挙動と将来拡張は明示的に分離します。

---

## 1. コンストラクタ（設定）

### 1.1 AgentOptions

Implemented（`packages/core/src/agent/agent.ts`）:

```ts
export type AgentOptions = {
  llm: BaseChatModel;
  tools: Tool[];

  systemPrompt?: string;
  maxIterations?: number;          // default: 200
  toolChoice?: ToolChoice;         // default: undefined

  // context management
  compaction?: CompactionConfig | null;      // default: enabled
  toolOutputCache?: ToolOutputCacheConfig | null; // default: enabled

  // DI
  services?: AgentServices;
  modelRegistry?: ModelRegistry;

  // usage
  enableUsageTracking?: boolean;   // default: true

  // tool permission hook
  canExecuteTool?: ToolPermissionHook;
};
```

Planned（未実装）:
- `llmMaxRetries` / `llmRetryBaseDelayMs` / `llmRetryMaxDelayMs` / `llmRetryableStatusCodes`
- `dependencyOverrides`

### 1.2 内部状態（概念）

Implemented:
- `history: HistoryAdapter`（実履歴。`commitModelResponse(response.messages)` で順序保持）
- `tools: Tool[]`
- `usageService: TokenUsageService`
- `compactionService?: CompactionService | null`
- `toolOutputCacheService?: ToolOutputCacheService | null`

---

## 2. run() の仕様

### 2.1 システムプロンプトの扱い

Implemented:
- `systemPrompt` が指定されている場合、`runStream()` 開始時に `history.enqueueSystem()` を呼ぶ
- `MessageHistoryAdapter` 側で「system は 1 回だけ」保持する

### 2.2 ループの擬似コード

```ts
run(message, { signal, session }) {
  enqueueSystemIfAny()
  enqueueUserMessage(message)

  while (iterations < maxIterations) {
    throwIfAborted(signal)
    trimToolOutputs()

    const input = history.prepareInvokeInput({ tools, toolChoice })
    recordLlmRequest(session, input)

    const response = await llm.ainvoke({ ...input, signal })
    recordLlmResponse(session, response)
    usageService.updateUsageSummary(response.usage)

    history.commitModelResponse(response) // response.messages をそのまま追加

    const { reasoningTexts, assistantTexts, toolCalls } = collectModelOutput(response.messages)
    emitReasoningEvents(reasoningTexts)

    const hasToolCalls = toolCalls.length > 0

    if (!hasToolCalls) {
      // terminal no-tool response
      yield* checkAndCompact()
      emitFinal(assistantTexts.join("\n").trim())
      return
    }

    for (toolCall of toolCalls) {
      emitStepStart/toolCall
      const execution = await executeToolCall(toolCall)
      enqueueToolResult(execution.message)
      emitToolResult/stepComplete
      if (execution.done) {
        emitFinal(execution.finalMessage ?? assistantTexts.join("\n").trim())
        return
      }
    }

    yield* checkAndCompact()
  }

  emitFinal(await generateFinalResponse())
}
```

Implemented:
- `response.messages` を Agent 側で再構成せず、そのまま履歴へ追加する
- tool call なしの終端では `text` を省略し `final` のみ emit する
- loop 内の LLM 呼び出しは現在リトライなし（1回呼び出し）

Planned:
- incomplete work hook（未完タスク促し）の実装

### 2.3 Cancellation / AbortSignal

Implemented:
- `run()` / `runStream()` は `options.signal` を受け取る
- ループ前・各反復・tool 実行前に abort を確認する
- `llm.ainvoke()` と `ToolContext` に `signal` を渡す
- cancel 時、`runStream` は `final` を出さずに終了し得る

---

## 3. runStream() の仕様

### 3.1 イベント順序（1反復）

Implemented:
1. `ReasoningEvent`（reasoning message がある場合）
2. `TextEvent`（終端 no-tool 以外）
3. 各 tool call ごとに:
   - `StepStartEvent`
   - `ToolCallEvent`
   - `ToolResultEvent`
   - `StepCompleteEvent`
4. 終了時に `FinalResponseEvent`

補足（Implemented）:
- tool call が無い終端では `TextEvent` を出さない

### 3.2 run() との関係

Implemented:
- `run()` は `runStream()` を消費し、最初の `final` を返す

---

## 4. Tool call 実行仕様

### 4.1 unknown tool

Implemented:
- `ToolMessage(is_error=true, content="Error: Unknown tool '...'")` を生成
- ループは継続

### 4.2 arguments の JSON parse 失敗

Implemented:
- parse 失敗時は `args = { _raw: <raw arguments> }` として `ToolCallEvent` を emit
- tool 実行自体は継続する（`executeRaw` に生の arguments string を渡す）

### 4.3 tool 実行例外

Implemented:
- tool 実行例外は `ToolMessage(is_error=true, content="Error: ...")` に変換
- `ToolResultEvent(is_error=true)` と `StepCompleteEvent(status="error")` を emit

### 4.4 done ツール（終了）

Implemented:
- `TaskComplete` 例外を tool 層から受けると `execution.done=true` として `final` で終了
- 履歴には done 側の tool message を残す

Planned:
- `DoneSignal` 戻り値方式のサポート

---

## 5. LLM リトライ

Implemented:
- 現時点で Agent ループ内リトライは未実装

Planned:
- 429/5xx などを対象に指数バックオフを導入
- provider エラー正規化（`ModelRateLimitError` / `ModelProviderError`）を前提に判定

---

## 6. 最大反復（maxIterations）到達時

Implemented:
- `generateFinalResponse()` で「要約用 user message」を追加した入力を一時的に組み立てて LLM 呼び出し
- 要約呼び出しは `tools: null`, `toolChoice: "none"`
- 履歴は直接変更せず、`[...history, summaryMessage]` の一時配列で処理
- 失敗時は固定フォールバック文を返す

---

## 7. 終了直前フック（incomplete todos 等）

Planned:
- `getIncompleteWorkPrompt` 相当の hook
- 現在は TODO コメントのみで、実行ロジックは未導入

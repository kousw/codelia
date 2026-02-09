# Agent Tasks Spec（Agent 実装タスク定義）

この文書は Agent 実装を「実行可能なタスク」に分解したものです。
仕様そのものは `agent-loop.md` / `core-types.md` を正とします。

---

## Task 0: Agent クラスの骨組み

やること:
- `Agent` コンストラクタと主要フィールドを用意
- `tools` を `Map<string, Tool>` に正規化
- `messages` / `tokenCost` / `compactionService` を初期化

acceptance:
- `new Agent(...)` が作成できる
- 依存の型エラーが無い（`tsc`）

---

## Task 1: run()（最小ループ）

やること:
- 初回のみ `systemPrompt` を追加
- user message を追加してループ開始
- `ainvoke` を呼ぶ（tools/toolChoice 付き）
- `AssistantMessage` を履歴に追加
- tool calls が無ければ終了

acceptance:
- 最小の往復（user → assistant）が動く
- `maxIterations` を超えない

---

## Task 2: tool 実行の安全化

やること:
- unknown tool / JSON parse error / tool error を `ToolMessage(is_error=true)` に変換
- tool result を履歴に追加
- done tool を検出（`TaskComplete` または `DoneSignal`）

acceptance:
- すべての異常系が ToolMessage に残る
- done で正常終了できる

---

## Task 3: runStream（イベント化）

やること:
- `AsyncIterable<AgentEvent>` としてイベントを順に yield
- `ReasoningEvent` → `TextEvent` → tool-related events → `FinalResponseEvent`
- `FinalResponseEvent` は必ず最後

acceptance:
- イベント順序がテストで固定できる
- 例外時でも破綻しない

---

## Task 4: LLM リトライ

やること:
- `ModelRateLimitError` / `ModelProviderError` を判定
- 指数バックオフ（jitter 付き）
- 最大リトライ回数・対象ステータスコードを設定可能にする

acceptance:
- リトライ対象エラーのみ再実行される

---

## Task 5: Context Management 統合

やること:
- ループ開始時に tool output cache のトリム判定を実行
- ループ末尾で compaction を判定・実行

acceptance:
- tool output 合計サイズの上限が守られる（古い出力がトリムされ参照IDが残る）
- threshold 超過で要約が挿入される
- `auto=false` の場合は compaction が抑止される

---

## Task 6: usage 集計

やること:
- `ChatInvokeUsage` を `TokenCost` に積算
- `getUsage()` で取り出せる

acceptance:
- 呼び出し回数分の usage が合算される

---

## Task 7: 追加フック

やること:
- `getIncompleteWorkPrompt` の hook を導入
- 未完 prompt があれば user message を追加してループ継続

acceptance:
- hook が無い場合は no-op
- hook が返した文字列が追加される

---

## Task 8: テスト

やること:
- MockModel で agent-loop の最小往復を検証
- tool 呼び出し / エラー / done のケースを追加
- runStream のイベント順をテスト

acceptance:
- 主要パスが自動テストで担保される

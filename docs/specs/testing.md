# Testing Spec（学びながら実装するためのテスト）

この文書は、TypeScript 版を “理解しながら” 実装するためのテスト戦略です。
目的は「先に動く核を作り、段階的に差分（provider/compaction/tool output cache）を理解する」ことです。

---

## 1. テストの前提

- テストランナーは `bun:test` を想定
- 本物の LLM API は使わない（CI/ローカルで安定しないため）
- provider connector は “serializer の単体テスト” と “SDK呼び出しは薄く” を基本にする
- 手動スモークは `INTEGRATION=1` のようなフラグで明示的に有効化する

---

## 2. 最初に作る MockModel

`BaseChatModel` を実装する `MockModel` を用意し、シナリオごとに `ChatInvokeCompletion`（`messages: BaseMessage[]`）を返す。

例:

1. 1回目: messages=[{role:"assistant", content:null, tool_calls:[echo]}]\n2. 2回目: messages=[{role:"assistant", content:"done"}]

---

## 3. Agent loop の単体テスト（優先順）

### 3.1 run()

- systemPrompt が最初の1回だけ入る
- tool call があると tool が実行され ToolMessage が履歴に入る
- tool calls が無いと終了する
- unknown tool のとき ToolMessage(is_error=true) になる
- tool arguments の JSON が壊れていると parse error ToolMessage になる
- maxIterations 到達時に “要約用の追加呼び出し” が行われる（MockModelで検証）

### 3.2 runStream()

- FinalResponseEvent が必ず最後
- tool call ごとの StepStart/ToolCall/ToolResult/StepComplete が順序通り
- reasoning がある場合 ReasoningEvent が出る
- tool call が無い終端では `text` ではなく `final` のみ出る

---

## 4. Tools の単体テスト

- zod validate が効く（不正入力は tool 実行前に弾く）
- tool return の serialize ルール（string/json/parts）
- tool 例外が is_error ToolMessage に変換される
- ToolMessage に `output_ref` が付与されるケースを確認する

---

## 5. Tool output cache のテスト

- 合計サイズ上限を超えたとき、古い ToolMessage がトリムされる
- トリム済み ToolMessage に `output_ref` が残る
- `tool_output_cache` で参照IDから展開できる

---

## 6. Compaction のテスト

### 6.1 threshold 超過で要約置換

- usage を MockModel から返し、threshold を超えるケースで compaction が発動する
- messages が “retain + summary” に置換される
- `auto=false` の場合は threshold 超過でも compaction が発動しない

### 6.2 tool_calls を持つ末尾 assistant の整形

- 末尾 assistant が tool_calls を持つ履歴を compaction に渡すとき、tool_calls が除去される（APIエラー回避のロジック）

---

## 7. Provider serializer のテスト（最小）

ここは “SDK呼び出しをしない” 方針で、以下を最低限確認する。

- 共通 Message → SDK形式への変換が落ちない
- ToolDefinition → SDK形式が生成できる
- SDK形式の tool call → 共通 ToolCall に戻せる

SDK実呼び出しの統合テストは、必要になった時点で “手動スモーク” として別途用意する。

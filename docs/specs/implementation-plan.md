# Implementation Plan Spec（学びながら実装する順序）

この文書は「仕様を理解しながら」段階的に実装するための手順書です。
各ステップは “完成条件（acceptance）” と “学べるポイント” を明確にします。

---

## 0. 前提

- まずは “core ライブラリ” を実装（Agent loop / tools / context）
- CLI（planningツールやファイル操作などの実用ツールセット）は core 完成後に作る
- 実 LLM API は最初は使わず、MockModel で進める（テスト容易性）

---

## 1. Step 1: core types を固める

対象: `docs/specs/core-types.md`

やること:
- BaseMessage / ToolCall / ToolDefinition / ChatInvokeCompletion / AgentEvent を TS で定義

acceptance:
- `tsc` が通る
- テストで `AgentEvent` の判別ができる（`switch(event.type)` が exhaustively check できる）

学べるポイント:
- “共通型を正にする” と provider 差分が薄くなる

---

## 2. Step 2: defineTool（zod→validate→serialize）を作る

対象: `docs/specs/tools.md`

やること:
- `defineTool()` を実装（input zod / execute / result serialize）
- JSON Schema 生成は一旦 stub でも良い（後で差し替え）

acceptance:
- zod validate が効く
- 例外時に is_error な ToolMessage 相当が作れる

学べるポイント:
- “ツールを安全に実行する” ための境界（JSON parse / validate / serialize）

---

## 3. Step 3: Agent の最小ループ（MockModel + echo/done）

対象: `docs/specs/agent-loop.md`
関連: `docs/specs/agent-tasks.md`

やること:
- `Agent.run()` を実装
- `MockModel` を作り、tool calls 往復をテストで再現

acceptance:
- 1) tool call → 2) tool result → 3) final text の往復が動く
- unknown tool / parse error / tool error が ToolMessage として履歴に入る

学べるポイント:
- エージェントの本体は “ただの while-loop” であること

---

## 4. Step 4: runStream（イベント化）

やること:
- `Agent.runStream()` を `AsyncIterable<AgentEvent>` で実装
- “ステップ”の概念をイベントに落とす（StepStart/Complete）

acceptance:
- 期待するイベント順序がテストで保証される
- FinalResponseEvent が必ず最後

学べるポイント:
- “ループ内部の状態” を UI/CLI が観測できる形に変換する方法

---

## 5. Step 5: tool output cache（トリム＋参照ID）

対象: `docs/specs/context-management.md`

やること:
- tool output cache にフル出力を保存し、参照IDを生成する
- 合計サイズ上限を超えたら古い ToolMessage をトリムする
- serializer がトリム済みの出力を placeholder にする（provider 実装前でも “共通 serializer” で確認）

acceptance:
- 合計サイズ上限に従って古い output がトリムされる
- placeholder に置換され、参照IDから展開できる

学べるポイント:
- “モデルに見せる履歴” と “内部保持” を分離する重要性

---

## 6. Step 6: compaction（要約置換）

やること:
- `CompactionService` を実装
- threshold 超過で履歴が要約1件に置換される
- 末尾 assistant tool_calls の除去ロジックを入れる

acceptance:
- threshold 条件で compact が動き、履歴が 1 件になる
- `<summary>` 抽出が動く

学べるポイント:
- 長期対話は “状態を要約に畳む” ことで継続できる

---

## 7. Step 7: usage 集計（costは後）

対象: `docs/specs/usage-tracking.md`

やること:
- `TokenCost` 相当を実装し、usage を積算して `getUsage()` で返す

acceptance:
- MockModel の usage を積算できる

学べるポイント:
- “何にどれだけ使ったか” が運用では重要

---

## 8. Step 8: provider connectors（OpenAI→Anthropic→Gemini）

対象: `docs/specs/providers.md`

やること:
- OpenAI connector を実装（messages/tools/toolChoice の変換）
- 次に Anthropic、次に Gemini

acceptance:
- それぞれが `ChatInvokeCompletion` を返せる（最低限）
- serializer の単体テストが通る

学べるポイント:
- “差分は provider で吸収する” の実際

---

## 9. Step 9: CLI（標準ツールセット）

やること:
- core を使って CLI を作る
- planning（todos）/ fs / grep / edit / bash / done などの “実用ツール” を同梱する

acceptance:
- デモとして “小さな coding assistant” が動く

学べるポイント:
- SDK とアプリ（cli）は分けた方が理解しやすい

# TypeScript版 Agent SDK Architecture Spec（Python実装の再現）

この文書は、`bu-agent-sdk`（Python）のコア機能を TypeScript で再現実装するための Architecture Spec です。

- 目的: **同等の挙動・同等の拡張ポイント**を持つ TS 実装に落とす
- 対象プロバイダ: **OpenAI / Anthropic / Gemini**（3つに絞る）
- 方針: まずは architecture を合意し、その後 `docs/specs/` に機能別の詳細 spec を作る

---

## 0. スコープ / 非スコープ

### スコープ（Python版の主要機能の再現）

- Agent ループ（`run` / `runStream`、履歴管理、最大反復、ツール実行）
- Tool 定義（スキーマ生成、DI相当、実行、結果のシリアライズ）
- Ephemeral ツール出力の破棄（ツールごとに「最後N件だけ保持」）
- Context compaction（しきい値で履歴を要約に置換）
- 3プロバイダ対応（OpenAI/Anthropic/Gemini）と serializer 層
- Token usage 集計（任意でコスト計算）
- Observability（任意で no-op）
- リトライ/エラーハンドリング（LLM呼び出し・ツール実行）

### 配布イメージ（core と cli を分離）

Python版の `examples/claude_code.py` のような「実用ツールセット + UI/入出力」を、TS側では `cli`（参照実装/配布物）として切り出す想定です。

- `core`: Agent ループ + provider + tool 基盤（最小）
- `cli`: 既定のツールセット（例: planning/todos、fs、grep、edit、bash等）と表示・対話

planning（todos）は「エージェントを安定させるための実用上の標準ツール」ですが、コアの必須機能にはせず **cli が標準で提供**する方針とします（コアは “planningツールが入っていても/いなくても” 動く）。

### 非スコープ（この段階では狙わない）

- deepagents 的な「計画ボード」「サブエージェント」「長期記憶/DB統合」など
- ブラウザ操作や OS サンドボックス（ツールとして追加はできるが、SDKのコア要件ではない）

---

## 1. 設計原則

- **Agent = for-loop**（できるだけ透明に、デバッグ容易に）
- **共通型を“正”にする**（プロバイダ差分は adapter/serializer が吸収）
- **TypeScriptは zod を中心にする**（ツール入力は zod で型推論 + バリデーション）
- **オプション機能は no-op で落ちる**（observability / cost など）

補足:
- モデル一覧は `packages/core/src/models/` にスナップショットとして置く
- alias は `default` など簡易名を想定（resolve は registry 経由）

---

## 2. Public API（目標）

### 2.1 Agent

- `new Agent({ llm, tools, ... })`
- `run(message): Promise<string>`
- `runStream(message): AsyncIterable<AgentEvent>`
- `clearHistory()`
- `loadHistory(messages)`
- `getUsage(): Promise<UsageSummary>`

TS側の API 名は揃える（Python版と完全一致でなくても、概念が対応していればOK）。

### 2.2 done ツール

- LLM が tool calls を返さなくなったら終了する（標準挙動）
- `done` は明示終了シグナルとして利用できるが、必須にはしない

### 2.3 planning（todos）は cli の標準ツールとして提供

モデルはテキストで計画を“勝手に”書けますが、長いタスクでは計画が揮発しやすいので、構造化した planning ツール（例: `write_todos`）を用意します。

- `core`: planning を必須にしない（再現実装のコア要件から外す）
- `cli`: planning を標準搭載し、UI/表示（ToDo一覧）や「未完ToDoがあれば差し戻す」挙動を提供する

この分離により、ライブラリ用途は最小を保ちつつ、CLI利用では “計画→実行→更新” の安定ループを提供できます。

---

## 3. Agent ループ仕様（挙動の要点）

### 3.1 メッセージ履歴

- 1回目の `run/runStream` のみ、`systemPrompt` があれば先頭に追加
- 以降は履歴に user/assistant/tool message を追加していく

### 3.2 1イテレーションの流れ（概念）

1. Ephemeral 出力の破棄（前イテレーション分）
2. LLM 呼び出し（messages + tools + toolChoice）
3. AssistantMessage を履歴に追加
4. tool calls があれば順に実行し ToolMessage を履歴に追加
5. Compaction の判定・実行
6. 終了判定（CLIモードなら「tool calls 無し」で終了）

### 3.3 最大反復到達

- `maxIterations` 到達時は、履歴から「何ができたか」を LLM で要約して返す（Python版の挙動を踏襲）

---

## 4. Tool 仕様（TS向けに再整理）

### 4.1 Tool定義（基本形）

- `name`, `description`
- `input`: Zod schema（ここから JSON Schema を生成）
- `execute(input, ctx)`
- tool output cache によるトリム/参照IDを前提にする

### 4.2 DI（Depends相当）

Pythonの `Depends` と同等の目的は「ツール実行時に依存を解決し、オーバーライドできる」こと。

TSでは実装詳細は任意だが、最終的に次を満たすこと:

- 依存は「同期/非同期どちらでも」解決できる
- Agent/テスト側から **dependency overrides**（差し替え）が可能

### 4.3 Result serialization / multimodal

- tool result は `string` or `JSON` or `content parts（text/image/document）` を許容
- serializer 層が provider 形式に変換できる形に統一する

---

## 5. Context management（Tool output cache / Compaction）

### 5.1 Tool output cache（ツール出力キャッシュ）

- 合計サイズ上限を超えたら古い出力からトリムして参照IDを残す
- トリムした出力は placeholder に置換され、参照IDから展開できる

### 5.2 Compaction（要約置換）

- `enabled=true` がデフォルト（Python版同様）
- `auto=true` がデフォルト（自動 compaction を抑止可能）
- `thresholdRatio=0.8` デフォルト
- しきい値はモデルのコンテキスト長から計算（取得できない場合はエラー；外側で metadata を取得して registry を enrich する前提）
- compaction では履歴全体を要約し、履歴を「要約1件」に差し替える
- 要約時は「末尾assistantの tool calls」などを調整し、プロバイダAPIエラーを避ける（Python版の prepare と同等）
- summary に追加指示（summaryDirectives）を付与できる

---

## 6. Providers（OpenAI / Anthropic / Gemini）

### 6.1 共通インタフェース

- `ainvoke({ messages, model?, tools?, toolChoice?, signal? }): Promise<ChatInvokeCompletion>`
- `ChatInvokeCompletion` は `messages`, `usage`, `stop_reason`, `provider_meta` を持つ
- Implemented: text/tool_calls/reasoning は `messages: BaseMessage[]` の順序で扱う

### 6.2 serializer 層

- 共通 Message/Tool 定義を、各 SDK が要求する形式に変換する
- 「trimmed な ToolMessage」は placeholder を送る
- OpenAI は Responses API（`responses.create`）を使う方針
- OpenAI の assistant 履歴復元時は `output_text` / `refusal` を使って input item を組み立てる

---

## 7. Token usage / cost

- すべての LLM 呼び出しの usage を集計し、`getUsage()` で返す
- cost 計算は `includeCost` が有効なときのみ行う（無効時は一切の外部取得をしない）

---

## 8. Observability（任意）

- 依存が無い場合は no-op
- ある場合は `run/runStream` と tool 実行を span で包める

---

## 9. 詳細 spec（参照）

機能別の詳細仕様は `docs/specs/` にまとめる。

- `docs/specs/core-types.md`（共通型・互換性の定義）
- `docs/specs/agent-loop.md`（run/runStream、終了条件、最大反復）
- `docs/specs/tools.md`（zod/JSON Schema、DI、serialization、tool output cache）
- `docs/specs/context-management.md`（tool output cache/compaction の詳細）
- `docs/specs/providers.md`（OpenAI/Anthropic/Gemini の adapter/serializer 方針）
- `docs/specs/storage.md`（usage/cost、tool output cache保存）
- `docs/specs/testing.md`（学びながら実装できるテスト順）
- `docs/specs/implementation-plan.md`（実装順序と acceptance）

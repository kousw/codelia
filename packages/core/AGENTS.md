# @codelia/core

SDK本体のパッケージ。エントリは `src/index.ts`、出力は `dist/`。
モデル定義は `src/models/` に配置し、`DEFAULT_MODEL_REGISTRY` から参照する。
OpenAI の既定値は `OPENAI_DEFAULT_MODEL` / `OPENAI_DEFAULT_REASONING_EFFORT` を export している。
OpenAI のモデル定義には `gpt-5.3-codex` を含める（Codex OAuth 互換のモデル選択を通すため）。
Anthropic (Claude) provider 実装は `src/llm/anthropic/` に配置する。
`@codelia/config` の `configRegistry` に defaults を登録する（`src/config/register.ts`）。
テストは `tests/` 配下に置き、`bun test` で実行する。
ツール定義の JSON Schema 生成は Zod v4 の `toJSONSchema` を使う。
DI 用のインターフェースは `src/di/` に配置する（例: model metadata, storage paths）。
Compaction は `modelRegistry` を参照して context limit を決定する（metadata は registry に反映させる）。
Tool output cache は `ToolOutputCacheService` が担当し、store は `AgentServices.toolOutputCacheStore` から供給する。
デフォルトのシステムプロンプトは `prompts/system.md`（`CODELIA_SYSTEM_PROMPT_PATH` で上書き可）。
外部からの参照は `getDefaultSystemPromptPath()` を使う（package.json 参照は避ける）。
Tool 実行前に `AgentOptions.canExecuteTool` を呼び、permission を確認できる（deny なら tool を実行しない）。
`canExecuteTool` の deny に `stop_turn: true` を返すと、permission deny を最終応答として turn を終了できる。
cross-boundary の安定型（`AgentEvent`, `SessionStateSummary`）は `@codelia/shared-types` を参照する。
`ContentPart` には provider-specific 拡張用の `type: \"other\"` を含み、未知 provider では degrade（テキスト化）して扱う。

## runStream events

`Agent.runStream()` は UI 向けの表示イベントを yield する。
- `text`: 途中経過/ストリーミング向け（将来は増分になる可能性がある）
- `reasoning`: 推論出力の要約や途中経過（UI 側の表示ラベルは任意）
- `final`: ターン完了。本文も持つ（UI は `final` のみで本文が来るケースに対応する）
`Agent.runStream()` は `AgentRunOptions.session` が渡された場合、`llm.request` / `llm.response`
および `tool.output` を session store に best-effort で記録する。
Session resume のために `Agent.getHistoryMessages()` / `Agent.replaceHistoryMessages()` を提供し、
履歴のスナップショット保存と復元に使う。

OpenAI Responses API は reasoning item の直後に対応する output item が必要なため、
モデル返却は `ChatInvokeCompletion.messages`（`BaseMessage[]`）を正本とし、history も同じ形式で保持する。
OpenAI Responses のリクエストは system メッセージを `instructions` に集約して送る。
Developer ロールは廃止し、system prompt のみを扱う。
OpenAI Responses の `store` は未指定時に `false` を設定する（stateless）。
OpenAI Responses は常に `stream=true` で呼び出し、`finalResponse()` で集約した結果を使う。
OpenAI の `response.output` を履歴として再投入する際、`parsed_arguments` / `parsed` など解析済みフィールドは除去する。
OpenAI Responses の `output_text` が欠ける場合は `response.output` の `output_text` 部分から合成して補完する。

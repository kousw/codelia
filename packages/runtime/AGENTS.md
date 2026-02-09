# @codelia/runtime

Core と UI を接続する runtime（JSON-RPC stdio サーバ）。
UI プロトコルの受信、Agent 実行、tool 実装の窓口を担う。
基本ツール（bash/read/write/edit/agents_resolve/grep/glob/todo/done）と sandbox を内蔵。サンドボックスの既定ルートは起動時のカレントディレクトリで、`CODELIA_SANDBOX_ROOT` で上書き可。

tool 定義ガイド（description / field describe）:
- `defineTool.description` は 1 文で簡潔に書く（目安 120 文字以内）。
- 何をするツールかを最優先で書き、実装詳細や重複説明は避ける。
- 数値パラメータの `describe` には、必要なときだけ `unit / default / max` を短く明記する。
- `describe` の文面は短く統一し、同じ意味の項目は同じ語彙で記述する（例: `0-based`, `Default`, `Max`）。
- 長い注意事項は AGENTS.md / spec 側に寄せ、tool schema 側には最小限だけ残す。

起動時にモデルメタデータを取得し、選択モデルが見つからない場合は `models.dev` を強制リフレッシュして再確認する。
システムプロンプトは `packages/core/prompts/system.md` を読み込む（`CODELIA_SYSTEM_PROMPT_PATH` で上書き可）。
モデル設定は `config.json` の `model.*` を読み込み、openai/anthropic を選択できる。
OpenAI は `model.verbosity`（low/medium/high）で `Responses API` の `text.verbosity` を上書きできる。
defaults は core 側が `configRegistry` に登録し、runtime は合成済みの設定のみ利用する。
プロジェクト設定（`.codelia/config.json`）は runtime で読み込み、global config と合成する（CLI は未対応）。
`CODELIA_CONFIG_PATH` で global config の場所を上書きできる。
RPC `model.list` / `model.set` でモデルの一覧取得と config 更新を行う（model.set は Agent を作り直す）。
`model.list` は `include_details=true` で context window / 入出力上限を返す（取得できない場合は省略）。
`model.list` の provider 未指定時は config の provider を優先して一覧を返す。
RPC `skills.list` で skills catalog（name/description/path/scope + errors）を返す。
RPC `context.inspect` で runtime/UI/AGENTS resolver のスナップショット（読み込み済み AGENTS.md パスを含む）を返す。
`context.inspect` は `include_skills=true` で skills catalog/loaded_versions を返せる。
`mcp.servers`（global/project merge）を読み込み、runtime 起動時に MCP server 接続を開始する。
MCP adapter tool は runtime で生成し、`@codelia/core` は MCP transport/lifecycle を持たない。
RPC `mcp.list` を提供し、`/mcp` 向けに server state/tool 数を返す。
MCP HTTP は `mcp-auth.json` の token を Bearer で付与し、401 時は refresh token で再取得を試みる。
OAuth が必要な MCP server は Authorization Code + PKCE（localhost callback）で認証し、取得 token を `mcp-auth.json` に保存する。
OAuth metadata は `/.well-known/oauth-protected-resource` と authorization-server metadata から自動検出し、`config.json` の `mcp.servers.<id>.oauth.*` で上書きできる。
OAuth metadata が解決できる HTTP server で 401 が返った場合、state は `auth_required` として扱い、`connect failed` ではなく認証待ちへ遷移する。
Session store は `sessions/YYYY/MM/DD/<run_id>.jsonl` に書き込み、runtime が
`run.start` / `run.status` / `run.end` / `agent.event` / `run.context` を記録する。
LLM 呼び出しと tool 出力は core の session hook から記録される。
Session resume 用に `sessions/state/<session_id>.json` を保存し、`session.list` と
`run.start.session_id` で復元する（履歴は run 終了時にスナップショット）。
`session.history` で過去 run の `agent.event` を再送し、TUI が履歴を再描画する。
tool 実行前に permission を判定し、UI confirm で承認を得る（allowlist/denylist は config の `permissions`）。
bash はコマンドを分割評価し、全セグメントが allow の場合のみ自動許可する。
bash ツールは `ctx.signal` による中断をサポートし、`run.cancel` 時に実行中コマンドを中断できる。
bash ツールの timeout は秒単位で、上限 300 秒にクランプする（異常に大きい値の指定を防ぐ）。
bash 経由で `rg` を使う場合は、`rg <pattern> .` のように検索パスを明示する（非対話 stdin 読み取りによるハング回避）。
confirm で「次回以降確認しない」を選ぶと project config に allow ルールを追記する。
bash の remember はコマンドを分割して、各セグメントを `command`（基本は1語/2語、`npx`/`bunx`/`npm exec`/`pnpm dlx`/`pnpm exec`/`yarn dlx` などの launcher 系は3語）で保存する。
`skill_load` は `permissions.*.skill_name` で skill 名単位の allow/deny を評価し、remember も `{ tool: "skill_load", skill_name }` で保存する。
`cd` は allowlist ではなく sandbox 内パスのみ自動許可し、sandbox 外は confirm とする（remember 保存もしない）。
permission confirm で `Deny` を選んだ場合、理由未入力なら turn を停止し、理由入力ありなら tool deny 結果を文脈に残して turn 継続する。

参照仕様:
- docs/specs/ui-protocol.md

開発用起動:
- OpenAI: `OPENAI_API_KEY=... bun packages/runtime/src/index.ts`
- Anthropic: `ANTHROPIC_API_KEY=... bun packages/runtime/src/index.ts`
- OpenAI OAuth HTTP の 4xx/5xx をログ出力したい場合: `CODELIA_DEBUG=1`
- compaction 後の履歴スナップショットを runtime log で確認したい場合: `CODELIA_DEBUG=1`（`compaction context snapshot ...` を出力）
- run lifecycle / tool event / transport backpressure を詳細追跡したい場合: `CODELIA_DEBUG=1`

Integration テスト:
- `INTEGRATION=1` かつ API キーがある場合のみ実行する。
- OpenAI: `OPENAI_API_KEY` + `CODELIA_TEST_OPENAI_MODEL`
- Anthropic: `ANTHROPIC_API_KEY` + `CODELIA_TEST_ANTHROPIC_MODEL`
- テストは XDG 環境変数を一時ディレクトリに向けて保存領域を隔離する。

実装メモ:
- runtime のエントリは `src/index.ts` → `src/runtime.ts` に委譲し、`src/rpc`, `src/tools`, `src/sandbox`, `src/utils` に分割済み。
- RPC ハンドラは `src/rpc/handlers.ts`（配線）と `src/rpc/run.ts` / `src/rpc/history.ts` / `src/rpc/model.ts`（責務別実装）に分割。
- 実行状態は `src/runtime-state.ts` にカプセル化。
- `createAgentFactory` は singleflight 化されており、同時初期化要求でも Agent 構築は1回のみ行う。
- `agent.event` は `@codelia/shared-types` の `AgentEvent` をそのまま protocol 通知へ流す。
- run.cancel で stream を途中終了した場合、次 run で壊れないよう `src/rpc/run.ts` で tool call / tool output の不整合履歴を正規化する。
- `run.start` は `force_compaction=true` を受け取ると、通常入力を使わず compaction を強制実行できる。
- run event 保存は `RunEventStoreFactory` 経由で作成し、`run.ts` から storage 実装詳細を隠蔽する。
- `session.history` は run ログ先頭の header 行をストリームで1行読み取りする（固定長バッファは巨大 header で切れるため使わない）。
- AGENTS hierarchy resolver は `src/agents/` にあり、初期 system prompt に `root -> cwd` の `AGENTS.md` を埋め込み、差分解決は `agents_resolve` ツールで明示的に行う。
- Skills resolver は `src/skills/` にあり、初期 system prompt には catalog のみを `skills_catalog` として注入する（本文は `skill_load` 実行時のみ）。
- Skills 用ツールは `skill_search` / `skill_load`。`skill_load` は session 内で `path + mtime` 再ロードを抑制する。
- read ツールは `offset`/`limit` を受け取り、1行2000文字・合計50KBで出力を打ち切る。
- tool_output_cache / tool_output_cache_grep を標準ツールとして提供する。
- grep ツールは file/dir 両方の `path` を受け取り、file 指定時は単一ファイルのみ検索する。
- edit ツールは `old_string === new_string`（かつ非空）をエラーにせず no-op success として返す。
- MCP 実装は `src/mcp/manager.ts` を中心に、`src/mcp/tooling.ts`（tool adapter/一覧取得）・`src/mcp/oauth-helpers.ts`（metadata/token helper）へ分離済み。
- MCP transport は `src/mcp/client.ts`（契約）+ `src/mcp/stdio-client.ts` / `src/mcp/http-client.ts` + `src/mcp/jsonrpc.ts` / `src/mcp/sse.ts` に分離済み。
- `src/mcp/stdio-client.ts` は request timeout 時にも abort listener を解除し、同一 `AbortSignal` への listener 蓄積を防ぐ。
- MCP HTTP client は Streamable HTTP の `text/event-stream` 応答を解釈し、`event: message` の JSON-RPC payload を取り出して処理する（`event: endpoint` など制御イベントは無視）。
- `src/mcp/sse.ts` の SSE パースは `eventsource-parser` を利用する（手書き block parser は廃止）。
- MCP auth 保存は `@codelia/storage` の `McpAuthStore` を利用する（`src/mcp/auth-store.ts` は re-export）。
- MCP OAuth callback 待機は既定 180 秒で timeout し、`CODELIA_MCP_OAUTH_TIMEOUT_MS` で上書きできる。
- MCP OAuth の PKCE/state 生成は `oauth4webapi` の utility を利用する。
- OAuth callback server / PKCE / state の共通実装は `src/auth/oauth-utils.ts` に集約し、OpenAI/MCP OAuth で共有する。
- `src/auth/oauth-utils.ts` の callback server は `node:http` で実装し、Node runtime で `Bun` 依存なしに動作する。
- `src/rpc/run.ts` の content debug 文字列化は `@codelia/core` の `stringifyContent(..., { mode: "log" })` を利用する。

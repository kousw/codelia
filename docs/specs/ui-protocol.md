# UI Protocol Spec（Core ⇄ TUI/Desktop）

このドキュメントは、Rust 製 UI（TUI / 将来の Desktop）と TypeScript 側の実行ランタイム（core + tools）
の間で使う **双方向プロトコル**を定義します。

前提:
- `packages/core/src/types/events/*` の `AgentEvent` は **core の runStream が生成する“ドメインイベント”**。
- UI と接続するためには `AgentEvent` だけでは不足し、**封筒（IPC） + UI→core 入力 + core→UI 要求**が必要。

この仕様は `packages/protocol` の “正” になる想定です。

---

## 0. 目的 / 非目的

目的:
- UI と実行ランタイムを **疎結合**にする（TUI/GUI の差し替えを可能にする）
- 互換性（version/capabilities）と拡張性（namespacing）を確保する
- “選択/確認/入力” 等、UI からの介入が必要なケースをサポートする

非目的:
- “UI の内部操作（キー入力/フォーカス移動）” を core に委譲する（UI は UI が持つ）
- token-by-token の LLM ストリーム（必要なら provider / 別イベントで拡張）

---

## 1. 役割（Actor）

- **UI**: Rust TUI（将来は Desktop UI も同一プロトコル）
- **Runtime**: TS 側のプロセス（core + tools を含む）。UI から見ると “サーバ”

> 現状の `packages/core` はライブラリなので、そのままではプロトコルを話さない。
> TUI から接続するには、`packages/cli`（または将来 `packages/runtime`）に **IPC サーバ**を置く想定。

---

## 2. Transport（運搬）

### 2.1 推奨: stdio

- UI が Runtime を spawn し、`stdin/stdout` で双方向通信する
- **stdout はプロトコル専用**、ログは **stderr** に出す（stdout 汚染を防ぐ）

### 2.2 Message framing（v0）

v0 は **NDJSON（JSON Lines）**を採用する:
- 1 行 = 1 JSON オブジェクト
- UTF-8
- 各メッセージ末尾は `\n`

将来:
- 大きなペイロードや厳密な境界が必要になったら length-prefix へ移行（`initialize` の version で交渉）

---

## 3. Wire Envelope（封筒）

本プロトコルは JSON-RPC 2.0 互換の形を採用する（実装容易性と相関のため）。

```ts
export type RpcId = string;

export type RpcRequest = {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params?: unknown;
};

export type RpcResponse = {
  jsonrpc: "2.0";
  id: RpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type RpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;
```

設計ポリシー:
- request/response は **相関 id** を必須にする（UI confirm 等で待ち合わせが必要）
- notification は fire-and-forget（`id` 無し）
- `params` は **将来拡張を許容**する（unknown/extra field を捨てない）

---

## 4. Versioning / Capabilities

### 4.1 `initialize`（必須）

UI は接続直後に `initialize` を送る。

`initialize` request params（例）:
```ts
export type InitializeParams = {
  protocol_version: string; // 例: "0"
  client: { name: string; version: string };
  ui_capabilities?: UiCapabilities;
};
```

`initialize` response result（例）:
```ts
export type InitializeResult = {
  protocol_version: string; // server が話せる version（互換なら同じ）
  server: { name: string; version: string };
  server_capabilities?: ServerCapabilities;
};
```

### 4.2 Capabilities（例）

UI 側:
- `supports_confirm`, `supports_prompt`, `supports_pick`
- `supports_markdown`, `supports_images`

Runtime 側:
- `supports_run_cancel`
- `supports_ui_requests`（Runtime→UI request を使う）
- `supports_mcp_list`（`mcp.list` で MCP の実行時状態を取得できる）
- `supports_skills_list`（`skills.list` で skills catalog を取得できる）

---

## 5. Run model（“1回の実行”）

チャット UI は通常「ユーザー発話 1 回 = agent 実行 1 回」になる。
この 1 回を `run` と呼ぶ。

### 5.1 `run.start`（必須）

UI → Runtime request。

params（例）:
```ts
export type RunStartParams = {
  input: { type: "text"; text: string };
  session_id?: string; // optional resume target
  ui_context?: UiContextSnapshot; // 任意: 現在の active file / selection 等
  meta?: Record<string, unknown>;
};
```

result（例）:
```ts
export type RunStartResult = {
  run_id: string;
};
```

### 5.2 `agent.event`（必須）

Runtime → UI notification。`AgentEvent` を運ぶ。

params（例）:
```ts
export type AgentEventNotify = {
  run_id: string;
  seq: number;              // 0..N（ordering）
  event: AgentEvent;        // packages/core/src/types/events
  meta?: Record<string, unknown>; // 将来の拡張（構造化 output 等）
};
```

> `AgentEvent` 自体は core の “表示用イベント” なので、UI が直接描画する前提で良い。
> ただし将来の拡張のため、wire では `seq` と `meta` を封筒側に持たせる。

補足（`text` と `final`）:
- `final` は「このターンが完了した」ことを示すイベントで、本文も持つ。
- `text` は途中経過/ストリーミング向けの本文イベント（将来は増分になる可能性がある）。
- UI は `text` と `final` の両方が来ることに依存しないこと（`final` のみで本文が来るケースがある）。

See `docs/specs/run-visibility.md` for UI rendering guidelines based on these events.

### 5.3 `run.cancel`（推奨）

UI → Runtime request。

params（例）:
```ts
export type RunCancelParams = { run_id: string; reason?: string };
```

result（例）:
```ts
export type RunCancelResult = {
  ok: boolean;
  status?: "running" | "completed" | "error" | "cancelled";
};
```

Runtime should treat run.cancel as best-effort and idempotent.
If the run is active, it must attempt to stop LLM calls and tool execution and
then emit `run.status` with `status: "cancelled"`.
If the run already completed, Runtime may return `ok: false` or `status: "completed"`.
After a cancelled status, no further agent events should be emitted for that run.

### 5.4 `session.list`（推奨）

UI → Runtime request. Resume 用のセッション一覧を取得する。

params（例）:
```ts
export type SessionListParams = {
  limit?: number; // default: 50
};
```

result（例）:
```ts
export type SessionListResult = {
  sessions: Array<{
    session_id: string;
    updated_at: string;
    run_id?: string;
    message_count?: number;
    last_user_message?: string;
  }>;
};
```

### 5.5 `session.history`（推奨）

UI → Runtime request. セッション履歴（agent.event）を再生する。

params（例）:
```ts
export type SessionHistoryParams = {
  session_id: string;
  max_runs?: number;   // default: 20
  max_events?: number; // default: 1500
};
```

result（例）:
```ts
export type SessionHistoryResult = {
  runs: number;
  events_sent: number;
  truncated?: boolean;
};
```

### 5.4 `run.status`（任意）

Runtime → UI notification。

```ts
export type RunStatusNotify = {
  run_id: string;
  status: "running" | "awaiting_ui" | "completed" | "error" | "cancelled";
  message?: string;
};
```

Notes:
- `status: "cancelled"` is terminal. UI should stop spinners and treat the run as ended.
- A cancelled run may not emit a final AgentEvent. UI must not wait for `final` if a
  terminal `run.status` is observed.

### 5.5 `run.context`（任意）

Runtime → UI notification。

```ts
export type RunContextNotify = {
  run_id: string;
  context_left_percent: number; // 0-100
};
```

### 5.6 `model.list`（任意）

UI → Runtime request。

params（例）:
```ts
export type ModelListParams = {
  provider?: string; // default: "openai"
  include_details?: boolean; // default: false
};
```

result（例）:
```ts
export type ModelListResult = {
  provider: string;
  models: string[];
  current?: string;
  details?: Record<string, {
    context_window?: number;
    max_input_tokens?: number;
    max_output_tokens?: number;
  }>;
};
```

### 5.7 `model.set`（任意）

UI → Runtime request。

params（例）:
```ts
export type ModelSetParams = {
  name: string;
  provider?: string; // default: "openai"
};
```

result（例）:
```ts
export type ModelSetResult = {
  provider: string;
  name: string;
};
```

### 5.8 `mcp.list`（推奨, `/mcp` で利用）

UI → Runtime request。

params（例）:
```ts
export type McpListParams = {
  scope?: "loaded" | "configured"; // default: "loaded"
};
```

result（例）:
```ts
export type McpListResult = {
  servers: Array<{
    id: string;
    transport: "http" | "stdio";
    source?: "project" | "global";
    enabled: boolean;
    state: "disabled" | "connecting" | "ready" | "error";
    tools?: number;
    last_error?: string;
    last_connected_at?: string;
  }>;
};
```

要件:
- UI は `/mcp` 表示時に `mcp.list(scope="loaded")` を呼ぶ。
- Runtime は run 実行中でも `mcp.list` を処理できる。
- `supports_mcp_list=false` の場合、UI は「MCP status unavailable」を表示する。

### 5.9 `skills.list`（推奨, `/skills` で利用）

UI → Runtime request。

params（例）:
```ts
export type SkillsListParams = {
  cwd?: string;
  force_reload?: boolean; // default: false
};
```

result（例）:
```ts
export type SkillsListResult = {
  skills: Array<{
    id: string;
    name: string;
    description: string;
    path: string;
    dir: string;
    scope: "repo" | "user";
    mtime_ms: number;
  }>;
  errors: Array<{ path: string; message: string }>;
  truncated: boolean;
};
```

要件:
- UI は `/skills` 表示時に `skills.list` を呼び、ローカル picker（検索/scope/filter）へ反映する。
- `supports_skills_list=false` の場合、UI は「Skills list unavailable」を表示する。

---

## 6. UI → Runtime（入力 / コンテキスト）

### 6.1 `ui.context.update`（推奨）

“選択/アクティブファイル”等は UI が持ち、必要なときだけ Runtime に共有する。
Raw key event を送らない（UI の都合を押し付けない）。

```ts
export type UiContextUpdateParams = {
  // 最小: “今どこで作業しているか”
  cwd?: string;
  workspace_root?: string;

  active_file?: { path: string; language_id?: string };

  selection?: {
    path: string;
    // 0-based. end は exclusive を推奨。
    range: {
      start: { line: number; column: number };
      end: { line: number; column: number };
    };
    // 任意: UI がすぐ出せるなら載せる（無ければ core が read_file tool で取る）
    selected_text?: string;
  };

  // 将来拡張用
  extensions?: Record<string, unknown>;
};
```

`UiContextSnapshot` は “その時点の UI 状態” を run.start に同梱するための別名。
```ts
export type UiContextSnapshot = UiContextUpdateParams;
```

使い所:
- agent 実行前に push（run.start の `ui_context` と合わせて “最新” を渡す）
- 選択が変わるたびに push（ただし頻度が高い場合は debounce）

---

## 7. Runtime → UI（confirm/prompt/pick）

“危険操作の承認” や “候補からの選択” は、UI の支援が必要。
これは **Runtime→UI の request** として扱う（応答を待てる）。

### 7.1 `ui.confirm.request`（推奨）

Runtime → UI request、UI → Runtime response。

params（例）:
```ts
export type UiConfirmRequestParams = {
  run_id?: string;
  title: string;
  message: string;
  confirm_label?: string; // default: "OK"
  cancel_label?: string;  // default: "Cancel"
  danger_level?: "normal" | "danger";
  allow_remember?: boolean; // default: false
  allow_reason?: boolean;   // default: false
};
```

result（例）:
```ts
export type UiConfirmResult = {
  ok: boolean;
  remember?: boolean; // remember allow/deny choice if supported
  reason?: string;    // optional free-form reason for deny
};
```

### 7.2 `ui.prompt.request`（任意）

```ts
export type UiPromptRequestParams = {
  run_id?: string;
  title: string;
  message: string;
  default_value?: string;
  multiline?: boolean;
  secret?: boolean;
};
export type UiPromptResult = { value: string | null }; // cancel => null
```

### 7.3 `ui.pick.request`（任意）

```ts
export type UiPickRequestParams = {
  run_id?: string;
  title: string;
  items: Array<{ id: string; label: string; detail?: string }>;
  multi?: boolean;
};
export type UiPickResult = { ids: string[] }; // cancel => []
```

---

## 8. 追加で必要になりがちなカテゴリ（将来）

TUI/desktop を “coding agent UI” として育てる際に必要になりがち:

- **Artifacts**: diff/画像/長文ログを `artifact_id` 参照で扱う（大容量対策）
- **Workspace API**: UI が file tree / preview を表示するための `workspace.list/read/search`
- **History API**: 会話履歴/ツール履歴の取得、エクスポート
- **Task/ToDo**: planning ツールと連携する `todos.update` 等
- **Clipboard**: copy/paste を明示的に扱う（TUI で便利）

これらは v0 の必須ではないが、method namespace を確保しておく:
- `artifact.*`
- `workspace.*`
- `history.*`
- `todos.*`

---

## 9. Error codes（案）

- `-32601` method not found（JSON-RPC）
- `-32602` invalid params
- `-32001` runtime busy（同時 run 制限など）
- `-32002` run not found
- `-32003` user cancelled

---

## 10. Examples（NDJSON）

initialize:
```json
{"jsonrpc":"2.0","id":"1","method":"initialize","params":{"protocol_version":"0","client":{"name":"codelia-tui","version":"0.0.0"}}}
```
```json
{"jsonrpc":"2.0","id":"1","result":{"protocol_version":"0","server":{"name":"codelia-runtime","version":"0.0.0"}}}
```

run.start:
```json
{"jsonrpc":"2.0","id":"2","method":"run.start","params":{"input":{"type":"text","text":"List TypeScript files"}}}
```
```json
{"jsonrpc":"2.0","id":"2","result":{"run_id":"run_123"}}
```

agent.event（notification）:
```json
{"jsonrpc":"2.0","method":"agent.event","params":{"run_id":"run_123","seq":0,"event":{"type":"reasoning","content":"...","timestamp":1730000000000}}}
```

ui.confirm.request（runtime→UI request）:
```json
{"jsonrpc":"2.0","id":"9","method":"ui.confirm.request","params":{"run_id":"run_123","title":"Run command?","message":"rg -n \"AgentEvent\" -S packages"}}
```
```json
{"jsonrpc":"2.0","id":"9","result":{"ok":true}}
```

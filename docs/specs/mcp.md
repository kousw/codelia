# MCP Integration Spec（Codelia as MCP Host）

この文書は、Codelia に Model Context Protocol（MCP）を統合するための仕様を定義する。
対象は「Codelia が Host として外部 MCP Server を利用する」ケースであり、
MCP Server を Codelia 自身が提供する仕様は含まない。

---

## 1. Goals / Non-Goals

Goals:
- MCP 標準仕様（2025-11-25）に準拠した接続・能力交渉・tool 呼び出しを実現する
- 既存の runtime permission / sandbox / session 設計を壊さずに統合する
- remote HTTP（Streamable HTTP + OAuth）を優先して実運用可能にする
- stdio 連携も同一 config モデルで扱えるようにする

Non-Goals:
- 初期段階で MCP 全機能（sampling / elicitation / tasks）を実装すること
- `@codelia/core` に MCP transport 実装を持ち込むこと
- Codelia の UI protocol を初期段階で大きく変更すること

---

## 2. Standard Baseline

準拠対象:
- MCP Specification revision `2025-11-25`
- JSON-RPC 2.0 envelope

初期実装で必須とする要件:
1. `initialize` -> `notifications/initialized` のライフサイクル遵守
2. capability negotiation（server: `tools`、client: 必要最小）
3. `tools/list`（pagination 対応）と `tools/call`
4. `notifications/cancelled` によるベストエフォートキャンセル
5. request timeout の実装（hung request 防止）
6. `/mcp` で「現在読み込み中/接続中の MCP server 状態」を表示できること

運用プロファイル別の必須条件:
- `production-http`（実運用・優先）:
  - 上記 1-6 に加えて、Remote HTTP/OAuth（Section 10）を必須とする
  - `MCP-Protocol-Version`/`MCP-Session-Id` の header handling を必須とする
  - protected server 接続時の auth/token 永続化を必須とする
- `local-stdio`（ローカル利用）:
  - 上記 1-6 を満たせば利用可能
  - `resources/*`, `prompts/*`, `completion/complete` は任意

将来検討:
- `tasks` utilities

---

## 3. Role Mapping（MCP <-> Codelia）

- MCP Host: Codelia runtime（`@codelia/runtime`）
- MCP Client: runtime 内のサーバ接続単位クライアント
- MCP Server: 外部プロセス/外部HTTP endpoint
- LLM/Agent Loop: `@codelia/core`（MCP transport を知らない）

設計原則:
- `core` は MCP 非依存を維持する
- runtime が MCP server 由来 capability を Tool にアダプトして core に渡す

---

## 4. Package Boundaries

### 4.1 `@codelia/runtime`

責務:
- MCP server 接続管理（起動/初期化/再接続/終了）
- MCP tools の発見と Tool adapter 生成
- MCP request timeout / cancel / logging
- permission との統合（人間承認フロー）

### 4.2 `@codelia/core`

責務:
- Tool contract に従って MCP adapter tool を通常 tool と同様に実行

禁止:
- MCP transport や lifecycle の実装を持たない

### 4.3 `@codelia/protocol`

初期段階:
- Core <-> UI protocol は変更しない（run.start/run.cancel 経由で利用）

将来:
- MCP server 状態表示や再読込操作が必要になった時点で method を追加

---

## 5. Config Schema（Proposed）

`config.json` に `mcp` セクションを追加する。

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "remote-tools": {
        "transport": "http",
        "url": "https://example.com/mcp",
        "enabled": true,
        "headers": {
          "X-Workspace": "codelia"
        },
        "request_timeout_ms": 30000
      },
      "filesystem-local": {
        "transport": "stdio",
        "command": "npx",
        "args": [
          "-y",
          "@modelcontextprotocol/server-filesystem",
          "/home/kousw/cospace/codelia"
        ],
        "cwd": "/home/kousw/cospace/codelia",
        "env": {
          "NODE_ENV": "production"
        },
        "request_timeout_ms": 30000
      }
    }
  }
}
```

型（案）:

```ts
type McpServerConfig = {
  transport: "stdio" | "http";
  enabled?: boolean;              // default true
  command?: string;               // stdio required
  args?: string[];                // stdio optional
  cwd?: string;                   // stdio optional
  env?: Record<string, string>;   // stdio/http optional
  url?: string;                   // http required
  headers?: Record<string, string>; // http optional static headers
  request_timeout_ms?: number;    // default 30000
  oauth?: {                       // http optional
    authorization_url?: string;
    token_url?: string;
    registration_url?: string;
    client_id?: string;
    client_secret?: string;
    scope?: string;
  };
};

type McpConfig = {
  servers: Record<string, McpServerConfig>;
};
```

server id（`servers` の key）バリデーション:

- 1..64 文字
- 正規表現: `^[a-zA-Z0-9_-]{1,64}$`
- 同一 config ファイル内で同一 id の重複定義は不可
- 複数レイヤ（global/project）で同一 id がある場合は既存仕様どおり project 側を優先

この制約は skill 名 validation と同様に「曖昧参照防止」と「運用時の識別子安定化」を目的とする。

備考:
- 実運用の優先対象は `transport: "http"` とする
- `transport: "stdio"` は local profile で継続サポートする

### 5.1 Minimal Examples

remote only:

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "remote-tools": {
        "transport": "http",
        "url": "https://example.com/mcp",
        "enabled": true
      }
    }
  }
}
```

stdio only:

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "filesystem-local": {
        "transport": "stdio",
        "command": "npx",
        "args": [
          "-y",
          "@modelcontextprotocol/server-filesystem",
          "/home/kousw/cospace/codelia"
        ],
        "enabled": true
      }
    }
  }
}
```

### 5.1.1 Practical Examples（copy/paste 用）

remote HTTP（実在・公開 endpoint / 認証不要）:

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "mcp-registry-public": {
        "transport": "http",
        "url": "https://registry.run.mcp.com.ai/mcp",
        "enabled": true,
        "request_timeout_ms": 30000
      }
    }
  }
}
```

remote HTTP（実在・公開 endpoint / 認証不要, 別例）:

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "petstore-public": {
        "transport": "http",
        "url": "https://petstore.run.mcp.com.ai/mcp",
        "enabled": true,
        "request_timeout_ms": 30000
      }
    }
  }
}
```

remote HTTP（実在 endpoint / OAuth 必須の例）:

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "notion": {
        "transport": "http",
        "url": "https://mcp.notion.com/mcp",
        "enabled": true,
        "request_timeout_ms": 30000
      }
    }
  }
}
```

remote HTTP（実在 endpoint / OAuth 必須, endpoint を明示指定する例）:

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "gossiper-oauth": {
        "transport": "http",
        "url": "https://mcp.gossiper.io/mcp",
        "enabled": true,
        "request_timeout_ms": 30000,
        "oauth": {
          "authorization_url": "https://mcp.gossiper.io/oauth2/authorize",
          "token_url": "https://mcp.gossiper.io/oauth2/token",
          "registration_url": "https://mcp.gossiper.io/oauth2/register",
          "scope": "mcp"
        }
      }
    }
  }
}
```

local stdio（filesystem server）:

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "filesystem-local": {
        "transport": "stdio",
        "command": "npx",
        "args": [
          "-y",
          "@modelcontextprotocol/server-filesystem",
          "/home/kousw/cospace/codelia"
        ],
        "cwd": "/home/kousw/cospace/codelia",
        "env": {
          "NODE_ENV": "production"
        },
        "enabled": true,
        "request_timeout_ms": 30000
      }
    }
  }
}
```

project 側で global 定義を無効化する例（`<cwd>/.codelia/config.json`）:

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "mcp-registry-public": {
        "transport": "http",
        "url": "https://registry.run.mcp.com.ai/mcp",
        "enabled": false
      }
    }
  }
}
```

補足:
- OAuth が必要な HTTP server で `mcp-auth.json` に token が無い/期限切れの場合、runtime は接続時に OAuth Authorization Code + PKCE フローを開始し、UI で browser 起動確認を表示する（token 手入力は不要）。
- OAuth metadata（`authorization_url`/`token_url`/`registration_url`）は `config.json` の `mcp.servers.<id>.oauth.*` で明示指定できる。未指定時は `/.well-known/oauth-protected-resource` と authorization-server metadata から自動検出を試みる。
- OAuth metadata を検出できない server は OAuth prompt を出さず、そのまま接続エラーとして表示する（例: API key header 必須 server は `headers.Authorization` を設定する）。
- `config.json` 内の `${...}` 形式は runtime で自動展開しない。`client_secret` を使う場合は実値を書き込む必要がある。
- `client_secret` の平文埋め込みは避け、可能なら prompt 入力運用や secret 配布手段を使う。
- 上記 `registry.run.mcp.com.ai` / `petstore.run.mcp.com.ai` は 2026-02-07 時点で `initialize` 応答を確認済み。
- 上記 `search-mcp.parallel.ai/mcp` は 2026-02-07 時点で `initialize` 401 と OAuth metadata（protected-resource + authorization-server）応答を確認済み。
- 上記 `mcp.gossiper.io/mcp` は 2026-02-07 時点で `initialize` 401 と OAuth metadata（`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`）応答を確認済み。

### 5.2 CLI Config Operations（Proposed）

`codelia mcp` サブコマンドで `config.json` の `mcp.servers` を編集できるようにする。
主目的は remote server を素早く追加・管理すること。

コマンド:

```bash
codelia mcp add <server-id> --transport http --url <mcp-endpoint> [options]
codelia mcp add <server-id> --transport stdio --command <cmd> [options]
codelia mcp list [--scope effective|project|global]
codelia mcp remove <server-id> [--scope project|global]
codelia mcp enable <server-id> [--scope project|global]
codelia mcp disable <server-id> [--scope project|global]
codelia mcp test <server-id> [--scope effective|project|global]
```

主要オプション:
- 共通:
  - `--scope <project|global>`（`add/remove/enable/disable`）
  - `--enabled <true|false>`（`add`）
  - `--request-timeout-ms <ms>`（`add`）
  - `--replace`（既存 id の上書き）
- http:
  - `--url <https://.../mcp>`（必須）
  - `--header <key=value>`（複数指定可）
  - `--oauth-authorization-url <https://.../authorize>`
  - `--oauth-token-url <https://.../token>`
  - `--oauth-registration-url <https://.../register>`
  - `--oauth-client-id <id>`
  - `--oauth-client-secret <secret>`
  - `--oauth-scope <scope>`
- stdio:
  - `--command <cmd>`（必須）
  - `--arg <value>`（複数指定可）
  - `--cwd <path>`
  - `--env <key=value>`（複数指定可）

スコープ既定値:
- `add/remove/enable/disable`: `project`
- `list/test`: `effective`

エラー/競合:
- `add` で同一 scope に同一 `server-id` がある場合:
  - `--replace` なし: 失敗
  - `--replace` あり: 上書き
- `remove` は対象 scope の定義のみ削除する
  - project で削除しても global 定義があれば effective には残る

出力:
- `list --scope effective` は `source`（`project`/`global`）を表示する
- `test` は接続・`initialize`・`tools/list` までを実行し、成否を返す

### 5.3 Config Loading / Merge Rules

MCP設定は既存 runtime config 読み込みと同じレイヤで扱う。

読み込み順（低 -> 高）:
1. Global config（`CODELIA_CONFIG_PATH` または storage default）
2. Project config（`<cwd>/.codelia/config.json`）

マージ規則:
- `mcp.servers` は server id（map key）単位でマージする
- 同じ server id が両方にある場合、project 側を優先する
- project で server を無効化する場合は `enabled: false` を使う
- `enabled !== true` の server は runtime 起動時に接続しない

妥当性チェック:
- `transport: "http"` は `url` 必須
- `transport: "stdio"` は `command` 必須
- 不正エントリはその server のみ無効化し、runtime 全体は継続する

### 5.4 Runtime Visibility Command（`/mcp` 必須）

`/mcp` は「設定済み」ではなく「runtime が現在認識している MCP 状態」を表示する。
`codelia mcp list`（静的設定）とは目的が異なる。

必須挙動:
1. `/mcp`:
   - 全 server の状態を一覧表示
   - 少なくとも次の列を含む:
     - `id`
     - `transport`
     - `source`（`project` / `global`）
     - `enabled`
     - `state`（`disabled` / `connecting` / `auth_required` / `ready` / `error`）
     - `tools`（現在公開中の tool 数）
2. `/mcp <server-id>`:
   - 指定 server の詳細表示
   - `last_error`（あれば）と `last_connected_at` を表示
3. server 未設定時:
   - 「no MCP servers configured」を明示表示

実装メモ:
- UI は runtime の `mcp.list` RPC を呼び出して表示する
- `/mcp` は run 実行中でも読み取り可能にする（状態確認のため）

---

## 6. Connection Lifecycle

各 server について runtime は以下を行う:

1. 接続確立（stdio subprocess 起動または HTTP endpoint 準備）
2. `initialize` request 送信
   - `protocolVersion`: `2025-11-25`
   - `clientInfo`: `{ name, version }`
   - `capabilities`: 最小（初期は `roots` 未提供）
3. `initialize` response 検証
   - `protocolVersion` 不一致で未対応なら切断
   - `capabilities.tools` が無い場合はその server の tool 連携を無効化
4. `notifications/initialized` 送信
5. `tools/list` で tool カタログ取得（cursor を使って全件）

再接続:
- 接続断は server 単位で扱い、他 server と local tools は継続
- run 中に切断した場合は当該 tool call を error として返す

---

## 7. Tool Adapter Contract

### 7.1 Tool Name Mapping

MCP tool 名は provider 制約を満たすよう runtime で正規化する。

- 公開名: `mcp_<serverId>_<toolSlug>_<hash8>`
- 逆引きテーブルで `(serverId, originalToolName)` に解決
- description に origin（`MCP server/tool`）を必ず含める

これにより:
- local tool との衝突を回避
- OpenAI/Anthropic 側の name 制約差分を吸収

### 7.2 Schema Handling

- MCP `inputSchema` は tool `parameters` に利用する
- `inputSchema` が不正/未定義の場合は
  `{ "type": "object", "additionalProperties": true }` にフォールバック
- schema は untrusted input として扱い、サイズ上限を設ける（DoS 防止）

### 7.3 Call Flow

1. Agent が adapter tool を call
2. runtime が permission 判定
3. MCP `tools/call` を送信
4. 応答を ToolResult に変換して core に返却

`isError: true` の場合:
- adapter は Tool 実行エラーとして返し、`ToolMessage.is_error = true` にする
- content には server が返したエラー内容を含める

### 7.4 Cancellation / Timeout

- request 毎に timeout を適用
- run cancel 時、in-flight MCP request に `notifications/cancelled` を送信
- 競合で response が後着しても無視できるようにする

---

## 8. Permissions / Safety

MCP tool は信頼境界をまたぐため、local tool より厳格に扱う。

1. デフォルト判定は `confirm`
2. 許可時 UI には `server/tool` と引数を明示
3. MCP metadata（description/annotations）は untrusted 扱い
4. 返却 payload はサイズ制限をかけ、超過分は省略 + 参照化
5. logging で secret をマスクする

---

## 9. Resources / Prompts（Phase 2）

Phase 2 で対応する範囲:
- `resources/list`, `resources/templates/list`, `resources/read`
- `prompts/list`, `prompts/get`

公開方法:
- local standard tool として公開（例: `mcp_resources_list`, `mcp_resource_read`）
- prompt は LLM 自動実行ではなく user-driven 操作を優先

通知対応:
- `notifications/resources/list_changed`
- `notifications/prompts/list_changed`

---

## 10. Remote HTTP / OAuth（Phase 1, production 必須）

Phase 1（remote 優先）で対応:
- Streamable HTTP transport（`POST`/`GET`/SSE）
- `MCP-Protocol-Version` / `MCP-Session-Id` header handling
- RFC9728 を使った protected resource metadata discovery
- OAuth 2.1 flow（MCP authorization spec 準拠）

`mcp-auth.json`（planned format）:

```json
{
  "version": 1,
  "servers": {
    "example-http-server": {
      "access_token": "...",
      "refresh_token": "...",
      "expires_at": 1760000000000,
      "token_type": "Bearer",
      "scope": "files:read",
      "client_id": "...",
      "client_secret": "..."
    }
  }
}
```

注記:
- stdio transport は MCP 標準どおり OAuth 対象外（環境変数/ローカル設定で管理）

---

## 11. Rollout Plan / Acceptance

### Phase 1（Remote MVP: HTTP/OAuth + tools）

Acceptance:
1. HTTP MCP server への `initialize`/`initialized` が成功する
2. `MCP-Protocol-Version`/`MCP-Session-Id` を含む通信が成立する
3. protected server に対して OAuth 経由で接続できる
4. `tools/list`/`tools/call` が run 中に実行でき、error/cancel が伝播する
5. permission confirm が機能し、deny 時は tool error になる

### Phase 2（Local parity: stdio + tools）

Acceptance:
1. stdio MCP server を `config.json` の同一 `mcp.servers` で扱える
2. run cancel で `notifications/cancelled` が送信される

### Phase 3（resources/prompts）

Acceptance:
1. resources/prompts 取得 tool が利用可能
2. list_changed 通知で次 run までに catalog が更新される

### Release Gates

- Remote Beta 条件:
  - Phase 1 完了（HTTP/OAuth + tools）
- Local Beta 条件:
  - Phase 2 完了（stdio parity）
- Production GA 条件:
  - Phase 1 完了（HTTP/OAuth を含む）
  - `production-http` プロファイルの必須条件を満たす

---

## 12. References

- MCP Spec 2025-11-25: https://modelcontextprotocol.io/specification/2025-11-25
- Lifecycle: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- Transports: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- Tools: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- Resources: https://modelcontextprotocol.io/specification/2025-11-25/server/resources
- Prompts: https://modelcontextprotocol.io/specification/2025-11-25/server/prompts
- Authorization: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization

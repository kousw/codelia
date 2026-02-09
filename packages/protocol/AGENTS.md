# @codelia/protocol

Core と UI（TUI/desktop）の間で使う UI プロトコルの型定義。
JSON-RPC 2.0 互換の封筒と、run/agent/ui 系のメッセージ型を提供する。
`@codelia/core` 非依存を維持する。
cross-boundary の共通型は `@codelia/shared-types` を参照する（core/runtime 実装型へ依存しない）。
model.list / model.set / session.list / session.history を含む（model.list は include_details で詳細を返せる）。
run.start は session_id を受け取れる。
MCP 状態表示用に `mcp.list` と `supports_mcp_list` capability を含む。
skills catalog 取得用に `skills.list` と `supports_skills_list` capability を含む。
context スナップショット取得用に `context.inspect` と `supports_context_inspect` capability を含む。
`context.inspect` は `include_skills` を受け取り、skills catalog 状態を返せる。
MCP transport handshake 用に `mcp-protocol.ts`（protocol version 定数/互換判定 helper）を提供し、runtime/cli で共有利用する。

参照仕様:
- docs/specs/ui-protocol.md

ビルド:
- bun run --filter @codelia/protocol build

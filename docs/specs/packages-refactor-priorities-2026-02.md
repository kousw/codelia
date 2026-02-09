# packages/ リファクタ優先度整理（2026-02-08）

## 目的
`packages/` 配下の肥大化ポイントを、責務分離・可読性・依存分離の観点で整理し、実行順付きでバックログ化する。

## 調査スナップショット
- TS実装規模（`src/`）
  - `@codelia/runtime`: 44 files / 6,923 lines
  - `@codelia/core`: 45 files / 3,759 lines
  - `@codelia/cli`: 1 file / 1,160 lines
  - `@codelia/mcp` 相当（runtime内）: 5 files / 2,040 lines
- 巨大ファイル
  - `packages/cli/src/index.ts` 1,160行
  - `packages/runtime/src/mcp/manager.ts` 929行
  - `packages/core/src/agent/agent.ts` 782行
  - `packages/runtime/src/mcp/client.ts` 631行
  - `packages/runtime/src/rpc/run.ts` 550行
- 依存・境界の気になる点
  - `@codelia/model-metadata` は `@codelia/protocol` を依存宣言しているが `src/` で未使用
  - `runtime` が `@codelia/core/types/llm/messages` へ deep import している（公開API境界を越える依存）
  - MCPのプロトコル定数・handshake処理が `cli` と `runtime` で重複

## 優先度基準
- `P0`: 機能追加時の衝突/退行リスクが高く、早期着手で効果が大きい
- `P1`: 次の開発サイクルで計画的に分離したい構造負債
- `P2`: 低リスクだが継続運用で効いてくる整理

## 優先度付きリファクタ案

### P0-1: CLI単一ファイルの責務分離
- ステータス: 対応済み（2026-02-08 phase1/phase2/phase3 実施）
- 対象: `packages/cli/src/index.ts`
- 現状の混在
  - TUI起動 (`runTui`)
  - MCP config CRUD (`runMcpCommand`)
  - MCP auth token管理 (`runMcpAuthCommand`)
  - MCP疎通テスト（HTTP/stdio probe）
- 提案
  - `src/commands/mcp/*.ts`, `src/tui/launcher.ts`, `src/mcp/probe.ts`, `src/args.ts` に分割
  - MCP authファイルI/Oは runtime の `mcp/auth-store` と共通化
- 実施内容（phase1）
  - `src/index.ts` を薄いディスパッチャに変更
  - MCP command 群を `src/commands/mcp.ts` に分離
  - TUI 起動処理を `src/tui/launcher.ts` に分離
  - `packages/cli/tests/mcp-protocol.test.ts` を追加
- 実施内容（phase2）
  - `src/args.ts` を追加し、引数処理を `cac` ベースに置換
  - MCP protocol 判定を `src/mcp/protocol.ts` に分離
  - MCP 疎通テスト処理を `src/mcp/probe.ts` に分離
  - MCP auth file I/O を `src/mcp/auth-file.ts` に分離
  - `packages/cli/tests/args.test.ts` を追加
- 実施内容（phase3）
  - `src/commands/mcp.ts` を薄い dispatcher 化し、`src/commands/mcp-config.ts` / `src/commands/mcp-auth.ts` に責務分離
  - MCP auth file I/O 実装を `@codelia/storage` の `McpAuthStore` へ共通化（runtime/cli で同一実装を利用）
- 期待効果
  - コマンド追加時の影響範囲縮小
  - 単体テスト導入しやすい構造へ移行

### P0-2: runtime MCP層の分割（manager/client/oauth）
- ステータス: 対応済み（2026-02-08）
- 対象
  - `packages/runtime/src/mcp/manager.ts`
  - `packages/runtime/src/mcp/client.ts`
  - `packages/runtime/src/mcp/oauth.ts`
- 現状の混在
  - 接続ライフサイクル
  - OAuth metadata discovery/refresh
  - tool adapter 生成
  - HTTP/stdio JSON-RPC transport
- 提案
  - `manager` を「接続状態管理」「OAuth token管理」「tool adapter生成」に分離
  - `client` を `stdio-client` / `http-client` / `jsonrpc helpers` に分離
  - MCP protocol version・互換判定ロジックを共有モジュール化（CLIと共通）
- 実施内容
  - `manager.ts` の pure helper を `tooling.ts`（tool adapter/一覧取得）と `oauth-helpers.ts`（metadata discovery/token parse）へ分離
  - `client.ts` を `stdio-client.ts` / `http-client.ts` / `jsonrpc.ts` / `sse.ts` へ分割し、`client.ts` は契約と re-export のみへ薄化
  - MCP protocol version 判定を `@codelia/protocol/src/mcp-protocol.ts` に集約し、runtime/cli の重複実装を解消
  - `packages/protocol/tests/mcp-protocol.test.ts` を追加し、共通 protocol helper をテストで固定
- 期待効果
  - MCP機能追加（auth/state/tool拡張）時の退行リスク低減
  - runtime と CLI の重複実装削減

### P0-3: 依存境界の即時是正（低コスト）
- ステータス: 対応済み（2026-02-08）
- 対象
  - `packages/model-metadata/package.json`
  - `packages/runtime/src/rpc/run.ts`
  - `packages/core/src/index.ts`
- 実施内容
  - `@codelia/model-metadata` から未使用依存 `@codelia/protocol` を削除
  - `@codelia/core` で `BaseMessage` を公開 export し、runtime/tests の deep import を置換
  - `scripts/check-workspace-deps.mjs` を追加し、workspace 依存の未使用/未宣言と deep import を検知
  - CI (`.github/workflows/ci.yml`) に `bun run check:deps` を追加
- 提案
  - 未使用依存 `@codelia/protocol` を `@codelia/model-metadata` から削除
  - `BaseMessage` を `@codelia/core` 公開APIへ再exportし、deep importを廃止
  - workspace内依存の未使用/未宣言を検知するCIスクリプト追加
- 期待効果
  - 依存グラフのノイズ削減
  - package境界の破壊を早期検知

### P0-4: ライブラリ活用による簡素化（先行）
- ステータス: 対応済み（2026-02-08）
- 対象
  - `packages/runtime/src/mcp/sse.ts`
  - `packages/runtime/src/mcp/oauth.ts`
  - `packages/cli/src/commands/mcp-config.ts`
  - `packages/cli/src/args.ts`
- 実施内容
  - SSE パースを手書き実装から `eventsource-parser` ベースへ置換
  - MCP OAuth の PKCE/state 生成を `oauth4webapi` へ置換
  - CLI MCP config 正規化を `zod` スキーマで宣言化
  - `cac` の返却値ラップを簡素化し、`options` 直読ベースへ整理
  - 回帰テスト追加: `packages/cli/tests/mcp-config.test.ts` / `packages/runtime/tests/mcp-http-client.test.ts`（chunk boundary ケース）
- 期待効果
  - 仕様/境界条件対応の再発明を抑制
  - パース/バリデーション周りの可読性・保守性向上

### P1-1: runtime composition root の再分割
- 対象: `packages/runtime/src/agent-factory.ts`
- 現状の混在
  - sandbox初期化
  - AGENTS resolver 初期化
  - tools構築
  - model/auth解決
  - permission confirm UI
  - Agent インスタンス組み立て
- 提案
  - `agent/bootstrap.ts`, `agent/provider-factory.ts`, `agent/permission-gateway.ts`, `agent/toolset.ts` へ分割
  - OAuth UI待機処理は `mcp/oauth-ui.ts` に切り出し
- 期待効果
  - 起動経路の可読性向上
  - UI確認フローとドメイン組み立ての疎結合化

### P1-2: config操作の共通化（runtime/cli重複解消）
- 対象
  - `packages/runtime/src/config.ts`
  - `packages/cli/src/index.ts`
  - `packages/config-loader/src/index.ts`
- 現状の混在
  - JSON raw 読み書き、version検証、部分更新ロジックが複数箇所に分散
- 提案
  - config更新ヘルパーを `config-loader` 側へ集約（model/mcp/permissions の更新API）
  - runtime/cli は「ユースケース呼び出し」のみに薄化
- 期待効果
  - 設定仕様変更時の修正点を1箇所へ集約
  - テスト対象の単純化

### P1-3: coreからprovider実装を段階分離
- 対象
  - `packages/core/src/llm/*`
  - `packages/core/src/index.ts`
- 背景
  - `package-architecture` 仕様で provider 分離方針が明示済み
  - core内 `llm` が 1,148行あり、ドメイン層にSDK依存が残っている
- 提案
  - `@codelia/providers-openai` / `@codelia/providers-anthropic` を新設
  - `core` には `BaseChatModel` 契約と最小実装のみ残す
  - 互換期間は `@codelia/core` から re-export で段階移行
- 期待効果
  - coreの責務純化
  - provider追加時の影響局所化

### P2-1: OAuthユーティリティの重複統合
- 対象
  - `packages/runtime/src/auth/openai-oauth.ts`
  - `packages/runtime/src/mcp/oauth.ts`
- 現状
  - PKCE/state生成、callback待機、HTML応答の基礎処理が重複
- 提案
  - `runtime/auth/oauth-utils.ts`（PKCE/state/callback server）を共通化
- 期待効果
  - 認証系バグ修正の重複作業を削減

### P2-2: message/content 文字列化ヘルパーの統合
- 対象
  - `packages/core/src/agent/agent.ts`
  - `packages/runtime/src/rpc/run.ts`
  - `packages/storage/src/session-state.ts`
- 現状
  - `ContentPart[] -> string` 系の変換が複数実装で微妙に分岐
- 提案
  - 用途別（ユーザー表示 / ログ用）ヘルパーを共通モジュール化
- 期待効果
  - 表示差分やログ差分の予期せぬズレを防止

### P2-3: テスト空白パッケージの最低限カバー追加
- 対象: `cli`, `model-metadata`, `protocol`, `shared-types`, `storage`
- 提案
  - まず snapshot/contract テストを小さく導入し、P0/P1リファクタの安全網を作る
- 期待効果
  - 構造変更に対する回帰耐性向上

## 実施順（推奨）
1. `P0-3`（依存境界の即時是正）
2. `P0-1`（CLI分割）
3. `P0-2`（runtime MCP分割）
4. `P0-4`（ライブラリ活用による簡素化）
5. `P1-1` + `P1-2`（runtime構成/設定責務の整理）
6. `P1-3`（provider分離）
7. `P2` 群（重複統合とテスト補強）

## 完了条件（このドキュメントの使い方）
- 各項目ごとに `plan/YYYY-MM-DD-*.md` を作成して段階実装する
- 1項目ずつ小さく進め、`bun run typecheck` と該当パッケージテストで回帰確認する

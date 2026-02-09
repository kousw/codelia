# Package Architecture Spec（Target Architecture）

この文書は Codelia の **目標アーキテクチャ** を定義する。
既存実装の都合よりも、長期運用・拡張性・安全性を優先した設計を採用する。

---

## 1. 目的

1. ライブラリ利用とアプリ利用を明確に分離する
2. 依存方向を固定し、責務のにじみを防ぐ
3. UI（Rust TUI / 将来 Desktop）と実行系を疎結合に保つ
4. セキュリティ境界（sandbox/permission/auth）を runtime に集約する
5. 段階的に移行できる形で仕様化する

---

## 2. 設計原則

### 2.1 一方向依存
上位レイヤは下位レイヤにのみ依存する。逆依存は禁止。

### 2.2 Core 最小化
`core` は Agent のドメインロジックのみを持つ。
ファイルI/O、認証、RPC、OS依存処理は持たない。

### 2.3 Wire 契約の独立
`protocol` は `core` の内部型に依存しない。
wire 型は `protocol` または `shared-types` で定義し、core 実装型に依存しない。

### 2.4 Runtime 集中
`runtime` は「実運用に必要な境界機能」（tool/sandbox/permission/auth/session/rpc/mcp）を一元管理する。

### 2.5 App 薄化
`cli` と `tui` は表示・入力・プロセス起動に責務を限定し、ビジネスロジックを持たない。

### 2.6 出力契約の正規化
モデル出力は provider ごとの断片表現ではなく、`BaseMessage[]` の順序列として core に渡す。
Agent は返却された `BaseMessage[]` を再集約せず順序どおり処理する（将来的な stream 処理の基礎）。
`usage` などの呼び出しメタデータは message 列と分離した補助フィールドとして扱う。

---

## 3. レイヤー構造

```text
Applications
  - @codelia/cli
  - crates/tui

Runtime Host
  - @codelia/runtime

Integration
  - @codelia/storage
  - @codelia/config-loader
  - @codelia/model-metadata
  - @codelia/providers-* (将来的分離)

Domain
  - @codelia/shared-types
  - @codelia/core
  - @codelia/config
  - @codelia/protocol
```

依存の基本形:

```text
cli/tui -> runtime -> core
runtime -> protocol, storage, config-loader, model-metadata
config-loader -> config
storage -> core(型) または shared-types
protocol -> shared-types
```

---

## 4. パッケージ責務

### 4.1 `@codelia/core`

責務:
- Agent loop（run/runStream）
- Tool contract（defineTool / Tool / ToolContext）
- 履歴管理 abstraction
- compaction / tool-output-cache / usage 集計のドメインサービス
- provider 抽象 interface

禁止:
- RPC 実装
- auth / permission
- sandbox / filesystem 操作
- storage 実装
- UI 依存

注記:
- OpenAI/Anthropic 実装は将来的に `providers-*` へ分離する
- 当面同居させる場合も import 境界は明示し、`core` の public API を分離する

### 4.2 `@codelia/protocol`

責務:
- JSON-RPC envelope
- initialize/run/session/model/ui-request の wire schema
- version/capabilities

禁止:
- core の内部型への依存
- runtime 実装コード

注記:
- `agent.event` / `session.list` などの cross-boundary 型は `shared-types` を参照できる
- protocol は core/runtime/storage へ依存しない

### 4.2.5 `@codelia/shared-types`

責務:
- cross-boundary で長期互換が必要な型の単一ソース化（例: `AgentEvent`, `SessionStateSummary`）

禁止:
- 他の workspace package 依存
- provider/runtime 実装都合の内部型の混入

### 4.3 `@codelia/runtime`

責務:
- Agent の composition root
- 標準 tools（bash/read/write/edit/grep/glob/todo/done）
- MCP client manager（外部 MCP server 接続/初期化/呼び出し仲介）
- sandbox/path guard
- permission policy
- auth（API key / OAuth）
- session lifecycle, cancel, busy 制御
- protocol server（stdio JSON-RPC）

禁止:
- UI 表示ロジック
- protocol 型定義の内製（必ず `@codelia/protocol` を使う）

必須運用:
- 単一ラン実行制御（run queue または mutex）
- `getAgent` 初期化の singleflight 化
- run 終了時の永続化と失敗ログの保証

### 4.4 `@codelia/storage`

責務:
- SessionStore / SessionStateStore / ToolOutputCacheStore 実装
- RunEventStoreFactory / SessionStateStore の実体提供（runtime へ DI）
- storage layout 解決

禁止:
- runtime 状態管理
- UI 依存

契約:
- runtime は `storage` 実装を直接 `new` しない
- runtime は `RunEventStoreFactory` / `SessionStateStore` の interface に依存する
- append-only の run イベント保存と session snapshot 保存を分離する

### 4.5 `@codelia/config` / `@codelia/config-loader`

`config`:
- スキーマ、デフォルト、型

`config-loader`:
- ファイル探索・ロード・マージ
- 書き込み helper

### 4.6 `@codelia/model-metadata`

責務:
- モデルメタデータ取得とキャッシュ
- runtime/core への提供

禁止:
- Agent loop への介入

### 4.7 `@codelia/cli`

責務:
- エントリポイント
- TUI 起動や fallback 起動

禁止:
- tool 実装再定義
- Agent 構築ロジックの重複実装

注記:
- 現在の `basic-cli` 相当は `examples/` へ移し、製品 CLI から分離する

### 4.8 `crates/tui`

責務:
- 画面描画とユーザー入力
- runtime 子プロセス管理
- protocol 通信

禁止:
- domain ロジック再実装

---

## 5. 依存ルール（強制）

1. `protocol` は `core` に依存しない
2. `shared-types` は他 workspace package に依存しない
3. `cli` は `runtime` を直接利用し、`core` 直呼びをしない（製品経路）
4. 標準 tools は runtime のみが持つ
5. sandbox は runtime 専有。core/tools contract へ逆流させない
6. storage 書き込み失敗は握り潰さず、少なくとも runtime ログに必ず残す
7. run イベント保存は factory 経由で生成し、runtime から実装詳細を隠蔽する

---

## 6. 実行パターン

### 6.1 Library Embed（最小）
- 利用者が `core` を直接使い、独自 tool / storage を組み合わせる
- これは SDK ユースケース

### 6.2 Runtime Embed（推奨）
- 利用者が `runtime` をサーバとして起動し、`protocol` 経由で利用する
- 標準 tools/sandbox/permission/auth が利用可能

### 6.3 End-user App
- `cli -> tui -> runtime` の経路を標準とする
- CLI は「UI 起動器」、runtime は「実行エンジン」として分離する

---

## 7. ディレクトリ方針

```text
packages/
  shared-types/
  core/
  protocol/
  runtime/
  storage/
  config/
  config-loader/
  model-metadata/
  cli/
examples/
  basic-cli/        # core 直利用サンプル（製品導線から分離）
crates/
  tui/
```

---

## 8. 移行計画（段階的）

### Phase 1: 境界の固定
1. `package-architecture` に沿って依存ルールを確定
2. `cli` から実装ロジック（tools/agent構築）を撤去し runtime 経由に寄せる
3. `basic-cli` を `examples/` へ移動
4. runtime の SessionStore 直 `new` を廃止し、factory 注入へ変更

### Phase 2: 契約の独立
1. protocol の core 依存を除去
2. cross-boundary 共通型を shared-types へ移設（protocol/core の重複を解消）

### Phase 2.5: LLM 出力契約の統一
1. `BaseChatModel.ainvoke` を `BaseMessage[] + meta` 契約へ移行
2. Agent は `BaseMessage` の順序ループで処理する
3. session 記録の `llm.response.output` は `messages` を唯一の canonical 表現とする

### Phase 3: 安全性と並行性
1. runtime の `getAgent` singleflight 化
2. run.start を mutex/queue で直列化
3. sandbox の symlink 実体解決チェック導入

### Phase 4: モジュール整理
1. provider 実装の分離（`providers-openai` / `providers-anthropic` など）
2. shared-types の対象型を段階的に拡張

---

## 9. 受け入れ条件

1. 全パッケージの依存が本仕様の方向に一致する
2. 製品導線で `cli` が tool 実装を持たない
3. protocol が core 非依存でビルド可能
4. runtime が単一ラン制御と明示的エラーログを持つ
5. `core` 単体利用と `runtime` 利用の両方が維持される

---

## 10. この仕様の位置づけ

この文書は **実装の最終到達点（North Star）** を示す。
短期的に未達の項目があっても、新規変更はこの方向に収束させること。

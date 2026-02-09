# Desktop Client (GPUI) Spec

この文書は、TUI とは別に Desktop クライアントを追加する際の実装方針を定義する。
前提は「実行エンジンは `@codelia/runtime` に一本化し、UI だけを増やす」。

## 1. 目的

- TUI と Desktop の両方から同じ runtime/protocol を利用できるようにする
- GUI で必要な機能（ファイルツリー、diff viewer）を段階的に追加する
- UI の差分で domain 実装が分岐しない構成を維持する

## 2. 現状（2026-02-07）

実装済み:
- `@codelia/runtime` は stdio JSON-RPC サーバとして動作する
- `@codelia/protocol` は `initialize/run/session/model/ui.*` を定義済み
- `crates/tui` は runtime を spawn し、UI プロトコルで会話実行している

未実装:
- `crates/desktop` の GPUI クライアント本体
- ファイルツリー / diff viewer 向けの専用 RPC

## 3. 設計原則

1. 実行境界の一元化:
`core/tools/sandbox/permissions` は runtime のみが扱う。

2. wire 契約の共通化:
Desktop 専用通信でも `@codelia/protocol` を使い、runtime 固有型を UI に漏らさない。

3. UI 責務の限定:
GPUI クライアントは描画・入力・操作状態に集中し、エージェント挙動は持たない。

## 4. 推奨構成

```text
crates/
  desktop/                  # GPUI app (Rust)
packages/
  protocol/                 # 共通 wire schema
  runtime/                  # 実行エンジン
  shared-types/             # cross-boundary stable types
```

補足:
- `crates/desktop` が runtime 子プロセスを直接 spawn して接続する。
- 画面は GPUI で完結させ、WebView/フロントエンド分離は行わない。

## 5. 通信モデル

```text
Desktop (GPUI, Rust)
  -> (stdio NDJSON JSON-RPC)
@codelia/runtime
  -> (notifications)
Desktop (GPUI)
```

要件:
- Runtime `stdout` は JSON-RPC 専用、ログは `stderr` に分離する
- UI 側で request id を管理し、response/notification を相関する
- クライアントの RPC 層は protocol message を透過転送し、業務ロジックを持たない

## 6. 実装フェーズ

### Phase 1: Chat MVP（TUI 同等）

機能:
- initialize/run.start/run.cancel
- agent.event/run.status/run.context 表示
- session.list/session.history による resume
- model.list/model.set
- mcp.list（`/mcp` 相当の状態表示）
- ui.confirm.request / ui.prompt.request / ui.pick.request

受け入れ条件:
- 同一入力で TUI と同じ runtime 応答が表示される
- confirm/prompt/pick が Desktop でも完結する

### Phase 2: Workspace Explorer（ファイルツリー）

機能:
- ワークスペースのツリー表示（lazy load）
- ファイル選択時の内容プレビュー
- `ui.context.update` に active file / selection を反映

受け入れ条件:
- sandbox 内のみ列挙/参照できる
- 大規模ディレクトリでも UI がフリーズしない

### Phase 3: Diff Viewer

機能:
- 編集結果 diff の表示（まず unified のみ）
- 変更ファイル単位の diff 切り替え
- `edit` ツール結果の diff と、ワークスペース差分を統合表示

受け入れ条件:
- 変更行の追加/削除が色分けで判読できる
- 大きな diff は省略表示しつつ操作継続できる

## 7. Protocol 拡張案（Phase 2/3）

Desktop のファイルツリー/diff viewer は、agent 実行とは独立した問い合わせが必要なため、
`workspace.*` 系 RPC を追加する。

候補:
- `workspace.tree`
- `workspace.read`
- `workspace.diff`

型の例:

```ts
export type WorkspaceTreeParams = {
  path?: string;
  depth?: number;
  include_hidden?: boolean;
};

export type WorkspaceTreeResult = {
  entries: Array<{
    path: string;
    name: string;
    kind: "file" | "dir";
    size?: number;
    mtime_ms?: number;
  }>;
};

export type WorkspaceDiffParams = {
  path?: string;
  context?: number;
};

export type WorkspaceDiffResult = {
  patch: string;
  truncated?: boolean;
};
```

補足:
- 既存 `read` / `edit` ツールの実装（sandbox, diff utility）は再利用する
- `@codelia/protocol` に型を置き、runtime で handler を実装する

## 8. セキュリティと制限

- すべて sandbox ルート配下で検証する
- `workspace.*` でも path traversal / symlink 実体解決を防止する
- 上限を設ける（例: tree 件数、read bytes、diff bytes）
- 制限超過時は `truncated` や明示エラーで返す（silent drop しない）

## 9. 非目標（この spec では扱わない）

- マルチウィンドウ同期
- リアルタイム共同編集
- 重量なコードハイライトエンジン（tree-sitter 等）

これらは `docs/specs/backlog.md` で管理する。

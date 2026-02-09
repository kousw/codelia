# @codelia/cli

CLIパッケージ。バイナリ名は `codelia`、エントリは `src/index.ts`。
既定で Rust TUI を起動するランチャーとして動作する。
`src/index.ts` は薄いディスパッチャで、MCP command は `src/commands/mcp.ts`、TUI 起動は `src/tui/launcher.ts` に分割済み。
`src/commands/mcp.ts` はルーティング専用で、実処理は `src/commands/mcp-config.ts` と `src/commands/mcp-auth.ts` に分割済み。
引数処理は `src/args.ts`（`cac` ベース）を使う。
MCP 関連の shared 処理は `src/mcp/` に分割済み（`protocol.ts` / `probe.ts` / `auth-file.ts`）。
MCP protocol version 判定ロジックは `@codelia/protocol` の `mcp-protocol` helper を使用する。
MCP auth 保存/読込は `@codelia/storage` の `McpAuthStore` を利用し、runtime と実装共通化している。
`src/commands/mcp-config.ts` の server config 正規化は `zod` スキーマを利用する。
`src/commands/mcp-config.ts` の config 更新（add/remove/enable/disable）は `@codelia/config-loader` の更新 API を利用する（raw JSON 更新ロジックは持たない）。
`src/args.ts` は `cac` の `options` を直接保持する薄いラッパーで、独自の Map/Set 変換は持たない。
`codelia mcp` サブコマンドで `config.json` の `mcp.servers` を編集/確認できる（`add/list/remove/enable/disable/test`）。
`codelia mcp auth` サブコマンドで `mcp-auth.json` の token を管理できる（`list/set/clear`）。
TUI 起動は `CODELIA_TUI_CMD` / `CODELIA_TUI_ARGS` で上書き可能。
TUI 起動解決は `optionalDependencies` の `@codelia/tui-*` を最優先し、未導入時は開発 fallback（`crates/tui/target/*`）と PATH fallback を使う。
`postinstall` でのバイナリコピーは行わない（実行時に platform package の `bin/` を直接解決する）。
サンドボックスの既定ルートは起動時のカレントディレクトリ。`CODELIA_SANDBOX_ROOT` を指定するとルートを上書きできる（初期ファイルは作成しない）。
製品導線として `@codelia/core` を直接呼ばない（tool 実装/agent 構築を持たない）。
旧 `basic-cli` 実装は `examples/basic-cli/` に移動済み。
CLI テストは `packages/cli/tests/` に置く（bun test）。

実行例:
- `bun run --filter @codelia/cli build`
- 対話モード(OpenAI): `OPENAI_API_KEY=... node packages/cli/dist/index.cjs`
- 対話モード(Anthropic): `ANTHROPIC_API_KEY=... node packages/cli/dist/index.cjs`
- サンドボックス固定: `OPENAI_API_KEY=... CODELIA_SANDBOX_ROOT=./tmp/sandbox node packages/cli/dist/index.cjs`

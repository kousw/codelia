# packages/tui

Rust TUI バイナリ配布用の platform package 群を配置するディレクトリ。

- 配置規約: `packages/tui/<platform-arch>/`
- package 名規約: `@codelia/tui-<platform>-<arch>`
- 各 package は `bin/` に実バイナリを持つ（コミット時は `.gitkeep` のみ可）。
- release 前に `bun run tui:stage` で対象 package の `bin/` へバイナリを配置する。
- 各 package の `prepack` は `scripts/verify-tui-binary.mjs` で `bin/` 内の実体を検証する。

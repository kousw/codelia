# TUI Distribution Spec

この文書は、`codelia` の TUI 配布と起動解決を、
**現行実装（Implemented）** と **目標仕様（Planned）** に分けて定義する。

## 1. Scope

- 対象: `@codelia/cli` から Rust TUI (`codelia-tui`) を起動する経路
- 対象外: UI プロトコル詳細、runtime/core の内部仕様

## 2. Current Behavior (Implemented)

根拠: `packages/cli/src/tui/launcher.ts` の `resolveTuiCommand()` / `resolveOptionalTuiBinaryPath()` / `runTui()`。

### 2.1 起動コマンド解決順

1. `CODELIA_TUI_CMD` があればそれを使用
2. `optionalDependencies` で導入された platform package から同梱バイナリを解決
   - 対応 package:
     - `@codelia/tui-darwin-arm64`
     - `@codelia/tui-darwin-x64`
     - `@codelia/tui-linux-arm64`
     - `@codelia/tui-linux-x64`
     - `@codelia/tui-win32-x64`
3. 開発 fallback として以下を探索（実行可能ビットあり）
   - `target/release/codelia-tui`
   - `target/debug/codelia-tui`
   - `crates/tui/target/release/codelia-tui`
   - `crates/tui/target/debug/codelia-tui`
4. どれも無ければ `codelia-tui`（PATH 解決）

### 2.2 既知の運用課題

- Partial: platform package が未導入・未公開の環境では開発 fallback / PATH fallback へ退避する。
- Partial: PATH 内にアクセス不能ディレクトリがある環境（例: WSL + Windows PATH 混在）では、
  `spawn codelia-tui EACCES` になる場合がある。

### 2.3 上書き手段

- `CODELIA_TUI_CMD`: 起動バイナリを完全上書き
- `CODELIA_TUI_ARGS`: TUI へ追加引数を注入

## 3. Packaging Layout

### 3.1 Implemented

- `@codelia/cli`: エントリポイント (`codelia`) と起動ロジック
- `@codelia/tui-<platform>-<arch>`: OS/arch 別 Rust TUI バイナリのみ
  - 例: `@codelia/tui-linux-x64`, `@codelia/tui-darwin-arm64`
  - パッケージ配置: `packages/tui/<platform-arch>/`

### 3.2 Implemented

- `@codelia/cli` の `optionalDependencies` に platform package を列挙
- `postinstall` コピーは使わず、実行時に `process.platform` / `process.arch` で対応 package の `package.json` を解決し、
  `<package>/bin/codelia-tui`（Windows は `.exe`）を直接起動対象にする。
- 各 platform package は `prepack` で `bin/` 内バイナリ存在チェックを行う。

### 3.3 Planned

- SHA256 検証と署名検証フローを CI/release へ組み込む。
- PATH fallback は互換維持のため当面残す。最終的には削除または opt-in 化する。

## 4. Failure Handling

### 4.1 Implemented

- `spawn` エラー時に失敗理由を表示し、
  `CODELIA_TUI_CMD/CODELIA_TUI_ARGS` の利用を案内する。
- `ENOENT` では対象 platform package 名（例: `@codelia/tui-linux-x64`）をエラー文に含める。

### 4.2 Planned

- PATH fallback 失敗（`ENOENT`/`EACCES`）時の診断をさらに詳細化する。

## 5. CI / Release

### 5.1 Implemented

1. `scripts/stage-tui-binary.mjs` で target package の `bin/` にバイナリを配置する。
2. `scripts/release-smoke.mjs` で `npm pack -> npm install -> node .../cli/dist/index.cjs mcp list` を実行する。
3. GitHub Actions `release-smoke.yml` で Linux/macOS/Windows matrix の smoke を実行する。

### 5.2 Planned

- 各 `@codelia/tui-*` package の publish 自動化（バージョン整合含む）。
- release artifacts の checksum/署名を publish パイプラインで検証する。

## 7. Status Table

- Implemented: `CODELIA_TUI_CMD` 上書き、platform package 解決、開発 fallback、PATH fallback、release smoke
- Partial: PATH fallback の診断粒度は限定的
- Planned: checksum/署名検証、PATH fallback 依存の縮小

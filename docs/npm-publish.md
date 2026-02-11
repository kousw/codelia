# npm Publish Runbook

`codelia` を npm に公開するための実運用手順です。  
このドキュメントは、現行実装（`scripts/*`, `package.json`, CI 設定）に合わせています。

## Status

- Implemented: 手動公開フロー + `npm pack` ベースの smoke 検証
  - 根拠: `scripts/release-smoke.mjs`, `.github/workflows/release-smoke.yml`
- Implemented: GitHub Actions からの全 platform npm 公開
  - 根拠: `.github/workflows/publish-npm.yml`
- Planned: release tag 作成をトリガーにした完全自動公開

## 公開対象パッケージ

### 1. Platform TUI packages（先に公開）

- `@codelia/tui-darwin-arm64`
- `@codelia/tui-darwin-x64`
- `@codelia/tui-linux-arm64`
- `@codelia/tui-linux-x64`
- `@codelia/tui-win32-x64`

### 2. TypeScript packages（依存順で公開）

1. `@codelia/config`
2. `@codelia/logger`
3. `@codelia/shared-types`
4. `@codelia/protocol`
5. `@codelia/core`
6. `@codelia/storage`
7. `@codelia/config-loader`
8. `@codelia/model-metadata`
9. `@codelia/runtime`
10. `@codelia/cli`

依存順は `scripts/release-smoke.mjs` の `packageOrder` に合わせています。

## 事前準備

1. npm へログインし、`@codelia` scope の publish 権限があることを確認する。

```sh
npm login
npm whoami
```

2. リリースするバージョンを全公開パッケージへ反映する。
3. workspace 内依存バージョンを同期する。

```sh
bun run bump:version <patch|minor|major|x.y.z>
bun run check:versions
```

`bun run bump:version patch` のように実行すると、`packages/` 配下の公開 package version と内部依存バージョンが一括更新されます。

4. ビルド成果物を作成する。

```sh
bun install
bun run build
bun run tui:build
```

## 手順

### Step 1: TUI バイナリを stage する

現在の OS/arch 向けに stage:

```sh
bun run tui:stage
```

特定ターゲット向けに stage（クロスビルド成果物を使う場合）:

```sh
bun run tui:stage -- --platform <platform> --arch <arch> --source <binary-path>
```

`prepack` 時に `scripts/verify-tui-binary.mjs` が `bin/` の実バイナリを検証します。

### Step 2: リリース smoke を実行

```sh
bun run smoke:release
```

このコマンドは以下を検証します（公開はしません）。

- `npm pack` で tarball 作成
- 一時プロジェクトへ `npm install`
- `@codelia/cli` の `mcp list` 実行確認

### Step 3: Platform TUI packages を公開

各パッケージで実行:

```sh
cd packages/tui/<target>
npm publish --access public
```

2FA が有効なら `--otp <code>` を付けます。

### Step 4: TypeScript packages を依存順で公開

```sh
for dir in \
  packages/config \
  packages/logger \
  packages/shared-types \
  packages/protocol \
  packages/core \
  packages/storage \
  packages/config-loader \
  packages/model-metadata \
  packages/runtime \
  packages/cli
do
  (cd "$dir" && npm publish --access public)
done
```

## 公開後チェック

```sh
npm view @codelia/cli version
npm view @codelia/runtime version
```

必要に応じて、クリーン環境で以下を確認します。

```sh
npm i -g @codelia/cli
codelia --help
```

## 失敗時の扱い

- 同一バージョンの再公開はできません。`version` を上げて再実行してください。
- `@codelia/cli` は `@codelia/tui-*` を `optionalDependencies` で参照するため、`cli` 公開前に TUI package の公開完了を推奨します。

## CI 公開（GitHub Actions）

workflow: `.github/workflows/publish-npm.yml`

### 事前設定

1. GitHub repository secret に `NPM_TOKEN` を設定する（`dry_run=false` の場合に必須）。
2. 公開対象バージョンへ `package.json` 群を更新し、`bun run check:versions` を通しておく。

### 実行方法

1. GitHub Actions の `Publish npm` を `workflow_dispatch` で実行する。
2. 入力値を指定する。
   - `dist_tag`: 例 `latest`, `next`
   - `dry_run`: `true` なら publish を行わず `npm publish --dry-run` を実行

### CI の公開順序

1. `publish-tui` job が matrix で 5 platform package を build/stage/publish
2. すべて成功後、`publish-ts` job が TypeScript packages を依存順で publish

既に同じ `name@version` が npm に存在する場合は、その package は skip されます。

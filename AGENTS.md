# codelia

TypeScript版のAgent SDKです。

## 基本方針

[docs/typescript-architecture-spec.md](docs/typescript-architecture-spec.md) 

## 実装

[docs/specs/](docs/specs/) に各機能の仕様が書かれています。
skills 仕様は `docs/specs/skills.md` に配置。
worker 実行時の隔離手法検討は `docs/specs/sandbox-isolation.md` に整理。
Deferred/Backlog のアイデアは `docs/specs/backlog.md` に集約する。
UI プロトコル（Core ⇄ UI）は docs/specs/ui-protocol.md と packages/protocol に配置。
cross-boundary の安定型（event/session summary など）は packages/shared-types に配置。
runtime は packages/runtime（UI から core/tools を利用するための IPC サーバ）。
TUI は crates/tui（runtime を起動する Rust 側スケルトン）。
Desktop GUI は crates/desktop（GPUI 予定）で実装し、runtime/protocol を再利用する。
ストレージのローカルレイアウトは docs/specs/storage-layout.md と packages/storage に配置。
runtime の tool description / field describe の記述ガイドは `packages/runtime/AGENTS.md` を参照。
CLI は暫定的な修正が入る前提のため、実装の優先度は TUI を上位とする。
agentic-web 方針（`docs/specs/agentic-web.md`）では、basic-web UI 流用のまま実行責務を durable-lite（API/Worker/Postgres/SSE tail）へ分離する。
OAuth は `dev-local` のみ loopback callback を許容し、`prod` は公開 callback + `oauth_state` DB 管理を前提とする（`docs/specs/auth.md` と整合）。

## 実装計画

[plan/](plan/) に実装計画が記載されています。

## Naming

- 2026-02-10: プロジェクト命名は旧名称から `codelia` へ移行済み。
- 新規実装では package scope / CLI 名 / 設定ディレクトリなどに `codelia` 系識別子を使用する。

## Rules

- 実装を行う場合には、[plan/](plan/) に実装計画を作成し、変更ががある場合には都度更新を行ってください。（ 2026-01-18-agent-name.md のようなファイル名にする）
- plan/ 配下の実装計画ファイルはコミットしないでください。
- 実装が完了したら、重要な情報がある場合には　AGENTS.md に追記を行ってください。
- AGENTS.md は各機能のディレクトリにそれぞれ用意し、その機能に関する把握しておくべき情報を追記してください。
- コーディングルールやプロジェクト設計に関わるルールは RULES.mdに記載してください。（AGENTS.mdと同様に必要なディレクトリに用意してください。）

## Development Environment

TypeScript version: x.x.x
Bun version: x.x.x

## Version Control

Git と jujutsu (jj) を colocate モードで併用しています。

- `.git` と `.jj` が共存、どちらのコマンドも使用可能
- 基本操作: `jj st`, `jj log`, `jj new`, `jj describe`
- コミット整理: `jj squash`, `jj split`
- Git 互換: `jj git push` で GitHub へ push

### jjの運用ルール
- **重要**: 作業単位で必ず `jj new` を切り、着手時に `jj describe` で説明を付ける
- **PR フロー運用（原則）**:
  - `main` は動かさず、トピック用ブックマークを作って push → PR
  - 派生: `jj edit main` → `jj new -m "wip: ..."` → `jj bookmark create <topic> -r @`
  - push: `jj git push --bookmark <topic>`
  - `jj git push` はブックマークが指す変更のみ push される
- **単独運用時**:
  - `main` を直接進める（`jj bookmark set main -r @` → `jj git push --bookmark main`）

## Testing / CI

- Tests run with `bun test` (unit tests live under `packages/*/tests`).
- Manual smoke/integration runs are opt-in via `INTEGRATION=1`.
- GitHub Actions runs lint, typecheck, and tests on push/PR.
- GitHub Actions includes dependency hygiene check (`bun run check:deps`) for workspace deps and deep-import violations.
- Workspace package version sync check is enforced by `bun run check:versions`.
- Release smoke check (`bun run smoke:release`) validates `npm pack -> npm install -> CLI smoke` and is run in `release-smoke.yml` on Linux/macOS/Windows.

## Utilities

- scripts/load-env.sh loads a .env file into the current shell when sourced: `source scripts/load-env.sh [path]`.

## Skills

- For testing tasks, use `typescript-bun-testing-best-practices` (linked under `.claude/skills` and `.codex/skills`).
- Use `jujujsu` skill when applicable (linked under `.claude/skills` and `.codex/skills`).

## Commands

- Use `bun run <script>` for project scripts (test/lint/fmt/check) to avoid ambiguity with built-in `bun` commands.
- Local verification (quick): `bun run fmt`, `bun run typecheck` (`bun run check` is optional if you want one-shot Biome checks).
- Dependency hygiene: `bun run check:deps`.
- Workspace version sync: `bun run sync:versions` / `bun run check:versions`.
- TUI binary staging for platform packages: `bun run tui:stage [-- --platform <platform> --arch <arch> --source <path>]`.

# Codelia

Codelia is a TypeScript Agent SDK.
It provides a runtime and a TUI.

## Basic policy

[docs/typescript-architecture-spec.md](docs/typescript-architecture-spec.md) 

## Implementation

Specifications for each feature are written in [docs/specs/](docs/specs/).
The skills specification is placed in `docs/specs/skills.md`.
Isolation method considerations during worker execution are organized in `docs/specs/sandbox-isolation.md`.
Deferred/Backlog ideas are consolidated in `docs/specs/backlog.md`.
The UI protocol (Core ⇄ UI) is located in docs/specs/ui-protocol.md and packages/protocol.
Stable cross-boundary types (event/session summary, etc.) are placed in packages/shared-types.
runtime is `packages/runtime` (an IPC server that lets the UI use core/tools).
TUI is `crates/tui` (full-screen Rust client that starts runtime and renders events).
Planned: Desktop GUI in `crates/desktop` (GPUI), reusing runtime/protocol.
Local storage layout is placed in docs/specs/storage-layout.md and packages/storage.
See `packages/runtime/AGENTS.md` for the runtime tool description / field describe description guide.
The CLI is expected to receive temporary fixes, so implementation priority is higher for the TUI.
The agentic-web policy (`docs/specs/agentic-web.md`) separates the execution responsibility into durable-lite (API/Worker/Postgres/SSE tail) while retaining the basic-web UI.
OAuth only allows loopback callback for `dev-local`, and `prod` assumes public callback + `oauth_state` DB management (consistent with `docs/specs/auth.md`).

## Implementation plan

The implementation plan is available at [plan/](plan/).

## Naming

- In new implementations, use `codelia`-prefixed identifiers for package scope / CLI name / configuration directory.

## Rules

- When implementing, please create an implementation plan in [plan/](plan/) and update it whenever there is a change. (Name the file like 2026-01-18-agent-name.md)
- Do not commit the implementation plan file under plan/.
- Once implementation is complete, please add any important information to AGENTS.md.
- Prepare AGENTS.md in each function's directory, and add any information you need to know about that function.
- Please write coding rules and rules related to project design in RULES.md. (Please prepare it in the required directory like AGENTS.md.)

## Development Environment

TypeScript version: 5.9.3 (workspace devDependency)
Bun version: 1.3.9 (packageManager in root `package.json`)

## Version Control

Git is required.

- `.git` is always present.
- Basic operations: `git status`, `git log`, `git commit`
- Push to GitHub with `git push`.

## Testing / CI

- JS unit tests run with `bun test packages/*/tests`; full local test entry is `bun run test` (includes TUI tests).
- Manual smoke/integration runs are opt-in via `INTEGRATION=1`.
- GitHub Actions runs lint, typecheck, and tests on push/PR.
- GitHub Actions includes dependency hygiene check (`bun run check:deps`) for workspace deps and deep-import violations.
- Workspace package version sync check is enforced by `bun run check:versions`.
- Release smoke check (`bun run smoke:release`) validates `npm pack -> npm install -> CLI smoke` and runs in `.github/workflows/release-smoke.yml` on Linux/macOS/Windows.
- npm publish workflow is `.github/workflows/publish-npm.yml` (`workflow_dispatch`, supports `dist_tag` and `dry_run`).

## Utilities

- scripts/load-env.sh loads a .env file into the current shell when sourced: `source scripts/load-env.sh [path]`.

## Skills

- For testing tasks, use `typescript-bun-testing-best-practices` (linked under `.claude/skills`, source in `.agents/skills`).

## Commands

- Use `bun run <script>` for project scripts (test/lint/fmt/check) to avoid ambiguity with built-in `bun` commands.
- Local verification (quick): `bun run fmt`, `bun run typecheck` (`bun run check` is optional if you want one-shot Biome checks).
- Dependency hygiene: `bun run check:deps`.
- Workspace version sync: `bun run sync:versions` / `bun run check:versions`.
- TUI binary staging for platform packages: `bun run tui:stage [-- --platform <platform> --arch <arch> --source <path>]`.
- npm publish runbook: `docs/npm-publish.md` (manual release order + smoke check).

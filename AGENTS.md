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
TUI is crates/tui (Rust side skeleton that starts runtime).
Desktop GUI will be implemented in `crates/desktop` (planned with GPUI), reusing runtime/protocol.
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

TypeScript version: x.x.x
Bun version: x.x.x

## Version Control

Git and jujutsu (`jj`) are used together in colocate mode.

- `.git` and `.jj` coexist, and both command sets are available
- Basic operations: `jj st`, `jj log`, `jj new`, `jj describe`
- Commit organization: `jj squash`, `jj split`
- Git interop: push to GitHub with `jj git push`

### jj workflow guidelines
- **Important**: For each unit of work, always create a new change with `jj new`, and add a description with `jj describe` when you start.
- **PR flow (default)**:
  - Keep `main` unchanged, create a topic bookmark, then push and open a PR.
  - Branching: `jj edit main` → `jj new -m "wip: ..."` → `jj bookmark create <topic> -r @`
  - Push: `jj git push --bookmark <topic>`
  - `jj git push` only pushes changes referenced by the bookmark.
- **When operating alone**:
  - Move `main` directly (`jj bookmark set main -r @` → `jj git push --bookmark main`).

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

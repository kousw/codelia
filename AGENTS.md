# Codelia

Codelia is a TypeScript Agent SDK (`packages/core`), JSON-RPC runtime (`packages/runtime`), Rust TUI (`crates/tui`), and CLI launcher (`packages/cli`).
TUI implementation takes priority over temporary CLI fixes. Use `codelia`-prefixed identifiers for package scopes, CLI names, and config directories.

## Commands & Verification

Always use `bun run <script>` for project scripts (`test`, `lint`, `fmt`, `check`) to avoid colliding with built-in `bun` subcommands.

- **Format / Lint / Typecheck**: Run `bun run fmt`, `bun run lint`, and `bun run typecheck` before major PRs (`bun run check` runs one-shot Biome format+lint; CI does not run a separate `fmt` step).
- **Hygiene & Codegen**:
  - `bun run check:deps` — workspace dependency graph & deep-import guard
  - `bun run check:versions` / `bun run sync:versions` — workspace package version sync
  - `bun run generate:protocol` / `bun run check:protocol` — generate & verify protocol artifacts from `packages/protocol/src/catalog.ts`
- **Tests**:
  - `bun run test:js` — JS unit tests (`packages/*/tests` and `tools/protocol-codegen`)
  - `bun run test:terminal-bench` — Terminal-Bench JS tests
  - `bun run test` — full local suite (`test:js`, `test:deps` for dep-checker script tests, `test:terminal-bench`, `crates/protocol`, `crates/tui`)
  - Root `bunfig.toml` preloads `scripts/test-preload.ts` (`CODELIA_AUTH_STORAGE=file`, real Keychain disabled, `CODELIA_TEST_PROTOCOL_ASSERT=1`). Live Keychain tests require `CODELIA_TEST_LIVE_KEYCHAIN=1`; live provider API tests require `INTEGRATION=1` (off in CI).
- **CI (`.github/workflows/ci.yml`)**: Runs `lint`, `@codelia/core` build, `typecheck`, `check:deps`, `test:deps`, `check:versions`, `check:protocol`, `test:js`, `test:terminal-bench`, `crates/protocol` (minimum Rust `1.93.1`), `crates/tui`, and Linux sandbox tests.
- **`bun.lock` rule**: After modifying or regenerating `bun.lock`, invalidate prior lint results — run `bun install --frozen-lockfile`, then re-run `bun run lint` on the final tree before push or merge.
- **Release & packaging**:
  - Every publishable npm package must declare `"license": "MIT"` and carry a package-local `LICENSE`.
  - Release smoke: `bun run smoke:release` (`.github/workflows/release-smoke.yml`); npm publish uses `.github/workflows/publish-npm.yml` with staged tag promotion — on registry propagation failure, rerun failed jobs rather than retagging by hand.

## Development Secrets

- Inject API keys for local runs or opt-in live tests through process environment variables (or your preferred secret manager).
- Keep local env/secret files (`.env*`, `.infisical.yaml`, etc.) gitignored and never copy secret values into source files, documentation, logs, or command output.
- `scripts/load-env.sh` is only for non-secret local env files, not dev API keys.

## Architecture & Coding Rules

- **Dependency boundaries** (keep acyclic and aligned with `dev-docs/reference-architecture.md`; update it if package dependencies change):
  - `@codelia/shared-types`: zero workspace dependencies; single source for stable cross-boundary types.
  - `@codelia/protocol`: depends on `@codelia/shared-types` only. Add or change RPC methods only in `packages/protocol/src/catalog.ts` (no hand-written TS/Rust/JSON method types) and run `bun run generate:protocol`; never hand-edit generated artifacts (`crates/protocol/src/generated.rs`, `packages/protocol/schema/protocol.schema.json`, `packages/protocol/schema/methods.md`, shared fixtures; minimum Rust `1.93.1`).
  - `@codelia/core`: domain logic only (no RPC, auth, sandbox, or storage implementations). Public types in `packages/core/src/types/` use `snake_case` fields and `input`/`output` usage names (not prompt/completion).
  - `@codelia/storage`: concrete store implementations; may depend on `@codelia/core` interfaces/types.
  - `@codelia/runtime`: composition root. Non-TUI hosts embed via the side-effect-free `@codelia/runtime/sdk` entrypoint (`dev-docs/specs/runtime-environment-contract.md`). Keep composition roots thin; do not pass aggregate mutable state (`RuntimeState`) into leaf modules — pass narrow typed inputs and explicit callbacks.
  - `@codelia/cli`: product entrypoint only; must not implement tools/agent construction or call `@codelia/core` directly.
- **Module hygiene & merge gates**:
  - No deep imports across package internals (use public exports only), no unused workspace dependencies, and no duplicated cross-package protocol constants/handshake logic.
  - Prefer small, typed modules with explicit exports (guideline: <~300 lines, review split >~500 lines). Split large mixed-responsibility entry files (command parsing, I/O, transport, orchestration) before merge.
  - Prefer explicit constructor/function injection at infrastructure boundaries over service locators, DI containers, or catch-all `common`/`utils` modules; keep shared helper modules free of feature-specific policy or mutable global state.
  - Never silently swallow errors (`catch(() => {})`) on main control flow. Intentional best-effort cleanup must preserve original failure behavior and include an inline comment explaining why ignoring that error is safe.
  - New or changed behavior requires tests in the owning package (`packages/*/tests` or `crates/*/src`). Resolve temporary structural exceptions or deferred test coverage in the same PR, or record reason, scope, and target date in `plan/`.

## Cross-Cutting Invariants

- **Portable product defaults**: Derive command discovery from the launching environment or explicit host settings; keep trusted system-component identity checks separate from user tool lookup. Express reusable permissions via executable, args, cwd, and effective authority rather than repo-specific defaults. Default confined file policy allows ordinary OS-account reads (including outside the workspace, with user/host opt-in private paths) while restricting writes and network access and protecting Codelia authority files independently. Keep controls on data sent to external providers distinct from local file access. Test host-specific exceptions with disposable fixtures/synthetic tools and keep personal paths, account IDs, and dev-machine assumptions out of product defaults.
- **Security, sandbox & handoff**:
  - Sandbox modes (`readonly | workspace-write | full-access`) are independent of command approval; keep requested vs applied modes distinct.
  - Direct RPC entry points must enforce the same permission gates as model-tool paths; auth, config, permissions, and sandbox management RPCs are user-initiated JSON-RPC actions, never exposed as model-callable tools.
  - No silent fallback across auth, model, endpoint, or billing routes, and no automatic replay of completed streams or uncertain requests. Never expose credentials, raw SDK errors/stacks, or opaque moderation/routing tokens in normal history, logs, or UI events.
  - Internal launcher-to-TUI handoffs use `--internal-launch-context=<json>` (never env vars). Debug switches go through `CODELIA_DEBUG=<topics>` + `CODELIA_DEBUG_DIR`; test hooks use `CODELIA_TEST_*`. Register any new `CODELIA_*` variable in `dev-docs/environment-variables.md`.
- **Protocol, streaming & providers**:
  - Clients resuming a session must bind it with `session.open` before a session-scope `model.set`; otherwise the first `run.start` overwrites that choice with the session's saved override.
  - Token deltas (`text.delta`, `reasoning.delta`) are opt-in (`supports_text_delta`), provisional, and never persisted or replayed; complete `text`/`reasoning`/`final` events are authoritative.
  - Provider additions and transport changes must verify normalized usage and timing through runtime `buildRunMetrics` (including reasoning and tool turns; extend `packages/runtime/tests/provider-metrics.test.ts` or provider metrics fixtures).
  - The Agent retry window limits backoff waits and whether another attempt may start; it must never abort an active provider request (connect/request/stream-idle timeouts belong to provider transport, with SDK retries disabled).
- **Tools & subagents**:
  - Built-in `defineTool` tools use `strict: false`, preserve Zod optional/defaulted fields as optional, and rely on runtime Zod validation (avoid nullable-required sentinels). Keep the shared system prompt high-level; keep tool and client-tool schemas self-sufficient (when to prefer, defaults, limits, sentinel IDs, result behavior).
  - Describe `detached_wait=true` as a runtime-managed child job only (never imply persistence across runtime exit; persistent services require shell-native detach/daemonization).
  - Subagents: register cancellation ownership before launch, retain capacity until executor cleanup is confirmed, separate parent-turn cancellation from accepted child lifetime (persist session ownership and tree accounting across turns), and propagate typed terminal reasons rather than inferring completion from prose. Shared-workspace conflicts use optimistic edit guards; parent/peer communication never widens delegated permission caps.

## Documentation & Context Policy

- Before editing a subtree, read its nearest `AGENTS.md`.
- `docs/` is user-facing; `dev-docs/` is maintainer architecture, specs, runbooks, and archives. Keep shared docs generic (no personal session contents, identifiers, local paths, usage counts, or storage measurements without explicit approval).
- Create/update non-trivial implementation plans in `plan/YYYY-MM-DD-<topic>.md` (`plan/` is gitignored; never commit plan files).
- **Keep `AGENTS.md` lean**:
  - Treat code, types, tests, and generated schemas as the truth source for *what* and *how*. Do not append per-feature changelogs, model token tables, tool/file lists, or implementation summaries to `AGENTS.md`.
  - Update `AGENTS.md` only for durable commands, cross-cutting invariants, non-obvious pitfalls, or canonical references.
  - Add nested `AGENTS.md` files only when a subtree has genuinely non-obvious local invariants; keep invariants inside `AGENTS.md` instead of creating parallel `RULES.md` files.
- Update `dev-docs/specs/` when public or cross-boundary contracts change.

## Canonical References

- Architecture & workspace dependency graph: `dev-docs/reference-architecture.md`
- Environment variable registry (`CODELIA_*`): `dev-docs/environment-variables.md`
- Specification index: `dev-docs/specs/README.md` (provider contracts: `dev-docs/specs/providers/README.md`)
- Generated RPC method catalog: `packages/protocol/schema/methods.md`
- Release / npm publish runbook: `dev-docs/npm-publish.md`
- Repository skills: `.agents/skills/agent-context-ops/SKILL.md`, `.agents/skills/typescript-bun-testing-best-practices/SKILL.md`

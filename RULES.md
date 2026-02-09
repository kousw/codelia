# Project Rules

## Coding Style
- Use Biome for linting/formatting/type checking; run `bun run lint` and `bun run fmt` and `bun run typecheck` before major PRs.
- Prefer small, typed modules with explicit exports; avoid magic globals.
- Keep public APIs documented in `docs/specs/` when behavior changes.
- Public types under `packages/core/src/types/` use `snake_case` fields; usage names follow `input/output` (not prompt/completion).
- Do not silently ignoring errors. Must handle them gracefully and return meaningful error messages or log them appropriately.

## Architecture / Dependencies
- Keep workspace package dependencies acyclic and consistent with the module dependency diagram in `docs/reference-architecture.md`.
- `@codelia/shared-types` is the single source for stable cross-boundary types (RPC/persistence/UI replay) and must not depend on other workspace packages.
- `@codelia/protocol` may depend on `@codelia/shared-types` only (no `core/runtime/storage` dependency).
- `@codelia/core` is domain logic only; infra concerns (RPC/auth/sandbox/storage impl) must stay out of core.
- `@codelia/storage` may depend on core interfaces/types, and must provide concrete store implementations.
- `@codelia/runtime` is the composition root and may depend on `core/protocol/storage/config-loader/model-metadata`.
- Product `@codelia/cli` must not implement tools/agent construction or call `@codelia/core` directly.
- Update the module dependency diagram whenever package dependencies change.

## Testing
- Use `bun test` as the default test runner.
- Unit tests live under `packages/*/tests` and use `*.test.ts` naming.
- Real API calls are opt-in only; gate them behind `INTEGRATION=1` and keep them off in CI.

## CI
- GitHub Actions runs lint, typecheck, and tests on every push/PR.

## Refactor Guardrails (MUST / SHOULD)

### Policy
- Big-bang implementation is allowed during development, but **before merge** the `MUST` rules below must be satisfied.
- Temporary structural debt is acceptable only when it is explicitly tracked and resolved in the same PR, or with a dated follow-up plan.

### MUST (merge gate)
- Do not introduce workspace dependency cycles; keep package dependency direction aligned with `docs/reference-architecture.md`.
- Do not add deep imports across package internals (e.g. `@codelia/core/...` from other packages). Use public exports only.
- Remove unused workspace dependencies from each `package.json` before merge.
- If package boundaries or public contracts change, update corresponding docs in `docs/specs/` and the dependency diagram in `docs/reference-architecture.md`.
- New or changed behavior must have tests in the owning package (`packages/*/tests`). If coverage cannot be added immediately, document risk and an explicit follow-up plan in `plan/`.
- Do not merge large mixed-responsibility entry files without separation points. Command parsing, I/O, transport, and domain orchestration must be split into modules before merge.
- Cross-package duplicated protocol constants/handshake logic must be centralized in a shared module before merge.

### SHOULD (default practice)
- Keep files focused and small (guideline: prefer under ~300 lines, split review when exceeding ~500 lines).
- Keep composition roots thin; move provider/auth/config/tool-specific logic into dedicated modules.
- Prefer one-way module dependencies inside packages (feature modules depend on shared helpers, not vice versa).
- Add tests alongside new modules during extraction refactors to preserve behavior.
- Run a periodic dependency hygiene check (unused deps, deep imports, duplicated constants) and fix drift early.
- When temporary exceptions are necessary, record reason/scope/target date in `plan/` at the start of work.

# packages/tui

Directory containing platform packages for Rust TUI binary distribution.

- Placement convention: `packages/tui/<platform-arch>/`
- Package name convention: `@codelia/tui-<platform>-<arch>`
- Each package has a real binary in `bin/` (only `.gitkeep` is possible at commit time).
- Place the binary in `bin/` of the target package with `bun run tui:stage` before release.
- `prepack` of each package verifies the entity in `bin/` with `scripts/verify-tui-binary.mjs`.

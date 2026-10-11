# Native desktop

Experimental Mac-first shell. See `dev-docs/specs/desktop/native-gpui.md` for current scope. From repo root use `bun run desktop:build`, `bun run desktop:test`, `bun run desktop -- /absolute/workspace`. Rust 1.95.0 and GPUI Kit 0.7.1 are pinned. `desktop:app` packages a local debug bundle that depends on this checkout's Bun/runtime/package builds, not a distributable release. Preserve existing runtime/protocol authority and other desktop worktrees.

Use `bun run desktop:test:ui` for opt-in headless GPUI interaction tests (`ui-tests` feature). Production builds keep test support disabled. Native visual/OS input verification remains separate.

Keep Cargo target directories and macOS bundle IDs distinct for side-by-side validation. Check the compiler source path and packaged executable hash before QA; a cached binary or stale app instance is not evidence for the current source.

The development bundle still reads the checkout runtime source. macOS can deny Documents reads to a GUI-launched subprocess even when terminal validation succeeds; Bun then reports `Module not found`. Diagnose the exact source read before treating Reconnect as a protocol fault. Respect denied access; do not relocate protected source or change permissions as a validation workaround.

Native QA bundles must use a Mach-O `CFBundleExecutable`, not a shell script main. Apple TCC expects native bundled main executables; do not mistake a script-launcher attribution failure for a missing broad disk permission. Keep synthetic provider/config isolation in the native launch design.

Thread/worktree restart checks use `bun crates/desktop/tests/thread-recovery-smoke.ts`; native drafts negotiate explicit fresh identity and exact model-session comparison. Uncertain run/create outcomes stay interrupted/unknown and are never auto-replayed. Acknowledged current composer drafts also survive app restart via the local state-root store; see desktop/drafts.md for coalescing and crash limits.

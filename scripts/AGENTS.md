# scripts

## Notes
- The preview PTY check also exercises `/image-model` command RPC and
  `/image-artifact` byte transfer against the fake peer. It matches fixture RGB
  output, not welcome-logo halfblocks. DSR responses must parse across PTY read
  boundaries and answer every query; a cursor-query timeout is not evidence that
  the permission handler rejected Esc. Real paid generation is a separate gated
  `packages/runtime/tests/image-generation-live.test.ts` check.
- `scripts/check-tui-image-preview.py <tui-binary>` runs the production TUI against a fake protocol peer in a macOS/Linux PTY. It checks local preview lifecycle, runtime-dialog preemption, no model submission, error recovery, protocol policy/cache cleanup, and terminal restoration. It does not verify real native pixels or use a real account.
- `scripts/check-tui-scrollback.mjs <capture.json> <dependency-directory>` replays the Rust `inline_native_scrollback_ansi_capture` fixture through pinned `@xterm/headless` installed outside the repo. It compares all buffer rows (including declared footer/padding), code styles, composer and cursor, not filtered markers. CI also runs `node --test scripts/check-tui-scrollback.test.mjs` with `CODELIA_TUI_CAPTURE_PATH` and `CODELIA_TUI_EMULATOR_DIR` set; negative controls ensure corrupted output fails. See `dev-docs/specs/tui-inline-scrollback-validation.md`.
- scripts/load-env.sh is a source-only helper to export variables from a .env file into the current shell: `source scripts/load-env.sh [path]`.
- scripts/setup-worktree.sh is a one-shot helper for freshly created/switched git worktrees; it resolves the repo root from the script location and runs `bun install`.
- scripts/setup-codelia-dev-alias.sh writes a managed alias block (default: `codelia-dev`) into `.bashrc`/`.zshrc` or a custom rc file.
- scripts/bump-workspace-version.mjs bumps all package versions under `packages/`, syncs workspace internal dependency versions, and updates `crates/tui/Cargo.toml` in one shot.
- scripts/release-workspace.mjs automates `bump:version` + `check:versions` + release commit + optional push (`--no-push`, `--allow-dirty`) and includes `crates/tui/Cargo.toml` in staged release-version changes.
- release-smoke.mjs includes the logger package in its tarball list so npm install doesn't fall back to the registry.
- release-smoke.mjs runs npm.cmd via a Windows shell to avoid spawnSync EINVAL on Windows runners.
- scripts/debug-openai-responses.mjs is a standalone OpenAI Responses repro helper; run it via `bun run debug:openai:responses -- --model gpt-5.4 --input test` to inspect raw `id/status/output_text/output/usage` outside Codelia.

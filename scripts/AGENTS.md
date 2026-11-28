# scripts

- **Dependency & release checks**:
  - `check-workspace-deps.mjs` (`bun run check:deps` / `bun run test:deps`): scans workspace `src`, `tests`, and `scripts` for undeclared/unused workspace deps and deep imports; fails explicitly on unsupported workspace glob syntax.
  - `bump-workspace-version.mjs` / `release-workspace.mjs` / `sync-workspace-versions.mjs`: keep `packages/*` and `crates/tui/Cargo.toml` versions synchronized.
  - `release-smoke.mjs` / `tui-platforms.mjs`: must pack `@codelia/logger` in tarballs, invoke `npm.cmd` via Windows shell (avoids `spawnSync` `EINVAL`), and drive Auto approve by choice ID (verifying workspace enable/disable separately from reviewer setup).
- **PTY & scrollback harnesses**:
  - `check-tui-image-preview.py` (`check-tui-image-preview_test.py`): drives real `codelia-tui` against a fake peer; DSR responses must parse across PTY read boundaries; wait for cursor show + final cursor movement + bounded quiet drain; clear `NO_COLOR` and declare truecolor in child when asserting ANSI RGB (`--repeat <n> --read-size <bytes>` stresses fragmented reads).
  - `check-tui-scrollback.mjs` (`check-tui-scrollback.test.mjs`): replays `inline_native_scrollback_ansi_capture` via external `@xterm/headless`, checking all buffer rows, styles, composer, and cursor plus negative controls (`dev-docs/specs/tui-inline-scrollback-validation.md`).
- **Windows MXC qualification**: `node scripts/qualify-windows-mxc.mjs <isolated-sdk-prefix>` uses the pinned V1 contract, verifies native library identity, uses disposable ACL/IPC resources, runs host network positive controls, and separates missing platform observations from measured access (`dev-docs/specs/windows-mxc-qualification.md`).
- **Utilities**: `load-env.sh` (non-secret `.env` only), `setup-worktree.sh`, `setup-codelia-dev-alias.sh`, `debug-openai-responses.mjs` (`bun run debug:openai:responses`).

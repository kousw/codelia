# CLI Self-Update

Status: Implemented (2026-11-23).

## 1. Goals and non-goals

Goals:

- Check npm dist-tags in the background on interactive TUI launches without slowing down startup or blocking prompt/subcommand invocations.
- Default to non-intrusive TUI startup notices (`update.mode: "notify"`) and an explicit `codelia update [--check]` command, so concurrent active sessions (which may launch subagent scripts from disk) are never surprised by in-place file replacement.
- Allow users who explicitly opt into `update.mode: "auto"` (or `CODELIA_AUTO_UPDATE=auto`) to apply cached updates on the next interactive TUI launch for standard writable `npm install -g` installations (including Homebrew Node, `nvm`, `fnm`, `mise`, `/usr/local`, and `~/.npm-global`), then re-exec the updated CLI.
- Stay simple and maintainable: use standard in-place `npm install -g --prefix <prefix> @codelia/cli@<version>` under a prefix-scoped exclusive lock rather than maintaining shadow release trees or launch-time forwarding layers.

Non-goals:

- Updating non-npm package managers automatically (Homebrew Cellar, Nix/Guix, pnpm, Bun, Yarn, Volta, mise npm backend, ephemeral `npx`, project-local `node_modules`, or source checkouts): these report update availability with a manual command hint instead.
- Shadow release trees (`.codelia-update/releases/`), `active.json` forwarders, or post-update macOS Keychain authorization probes (unnecessary because Keychain uses Apple-signed `/usr/bin/security`).
- Guaranteeing uninterrupted subagent launches inside older sibling sessions after an in-place update: because in-place `npm install -g` replaces files on disk, `notify` is the default and users should run `codelia update` when other sessions are idle (or opt into `auto` accepting that tradeoff).

## 2. Configuration

Global `config.json` only (project-level `.codelia/config.json` is ignored for self-update):

```json
{
  "version": 1,
  "update": {
    "mode": "notify",
    "channel": "latest"
  }
}
```

- `update.mode`: `"notify"` (default) | `"auto"` (opt-in) | `"off"`.
- `update.channel`: optional npm dist-tag name (rejects reserved `codelia-staging-*`). When omitted, stable versions infer `"latest"` and prereleases (e.g. `0.2.0-beta.1`) infer their leading prerelease identifier (`"beta"`).
- Environment overrides:
  - `CODELIA_AUTO_UPDATE`: `"auto" | "1" | "true" | "notify" | "off" | "0" | "false"`.
  - `npm_config_registry`: standard npm HTTPS registry base URL (must use `https:` without embedded credentials).
  - Channel selection uses `update.channel` in global `config.json`.
- Non-interactive runs and CI (`CI=true`, `GITHUB_ACTIONS`, etc.) always disable background checks and automatic installs.

### Startup confirmation

An interactive CLI launch schedules an update-mode confirmation when the global
`update.mode` is absent, including a missing config file or an `update` object
with only `channel`. Explicit settings, `CODELIA_AUTO_UPDATE`, CI, non-interactive
runs and unreadable or malformed update settings do not prompt.

The TUI shows the confirmation before normal composer dispatch and after any
runtime dialogs. Choose `notify` (preselected), `auto`, or `off` to save the
preference; Esc leaves it unset, so it can be offered again on a later eligible
launch. Saving does not change this launch's update policy, fetch from npm, or
start an install. Both update pickers accept Enter only after the full selected
option is visible; Esc still cancels in a small terminal. Supported `auto`
installs can apply a cached update on a later launch as usual.

### TUI `/update`

- Shows the version of the local CLI and the newer cached candidate for the current channel and registry, if one exists. No cached candidate does not mean the installation is up to date; use `codelia update --check` for a fresh lookup.
- Preselects the saved mode and displays environment overrides or unsupported automatic installs. Use Up/Down to choose `notify`, `auto`, or `off`, Enter to save only `update.mode` in the global config, or Esc to close without saving.
- Config writes go through the same per-file lock as runtime config mutations; the whole read-modify-write is serialized.
- The command uses the local launcher even with a remote runtime. Opening or saving does not query npm, install a package, or change the update policy of the running launch. The saved preference is read on subsequent launches; eligible `auto` launches can apply a cached update before starting the TUI.

## 3. State and lifecycle

Cache files live under `<cacheDir>/update/`:

- `state.json` (`0o600`, atomic write, serialized via `state.json.lock.sqlite`): caches `last_check_at`, `last_check_ok`, `channel`, `registry_id` (SHA-256 of normalized registry URL), `configured_channel`, `latest_version`, `checked_version`, `applied`, and `apply_failure`. If a check fails after changing channel or registry, any stale `latest_version` and `apply_failure` from the previous scope are cleared immediately.
- Install-scoped apply lock (`<prefix>/lib/node_modules/.codelia-update.lock.sqlite` on POSIX, `<prefix>/node_modules/.codelia-update.lock.sqlite` on Windows): short exclusive SQLite lock located inside the target installation's writable `node_modules/` directory (independent of both `XDG_CACHE_HOME` and `TMPDIR`) acquired during `applyUpdate()`. If another process is already updating the same installation, concurrent launches return `deferred` immediately and continue starting the current TUI.
- `notices/notice-<pid>-<rand>.json`: ephemeral `0o600` JSON file (`{"notices": [...]}`) passed to the TUI as `update_notice_file` in the `--internal-launch-context=<json>` argument, read bounded (≤ 8 KiB) and sanitized in `crates/tui/src/entry/bootstrap.rs`, and deleted on exit.

Check cadence:

- On interactive TUI launches, background checks run after the TUI spawns when `mode !== "off"` and `method.kind !== "development"`. A successful result is reused for 2 hours; a failed check can be retried on launch after 5 minutes. Changes to the registry URL, configured channel, or running version bypass those intervals. There is no periodic polling while the TUI stays open.
- Registry lookups request `<registry>/-/package/%40codelia%2Fcli/dist-tags` with `redirect: "error"`, 5-second timeout, and 256 KiB cap.

Apply flow (`applyUpdate()`):

1. Detect `npm-global` layout (`<prefix>/lib/node_modules/@codelia/cli` on POSIX, `<prefix>/node_modules/@codelia/cli` on Windows) with a matching `bin/codelia` link and writable `node_modules/@codelia` directories.
2. Resolve `npm` next to `process.execPath` first, then absolute `PATH` entries, rejecting group/world-writable or foreign-owned executables on POSIX.
3. Acquire the prefix-scoped SQLite lock (250 ms wait budget). Re-verify the on-disk version and cached target.
4. Run `npm prefix -g` (without `--prefix`) and confirm the active `npm` manages `<prefix>` (canonical equality).
5. Run `npm install -g --prefix <prefix> --no-audit --no-fund @codelia/cli@<version>` (120 s timeout).
6. Verify `package.json` inside `packageRoot` now reports `<version>`, record `applied` in `state.json`, and (on opt-in `auto` TUI startup) re-exec the updated entry once with `CODELIA_UPDATE_REEXEC=<from>`.

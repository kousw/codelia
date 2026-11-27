# Environment variable inventory

**Status.** Up-to-date inventory of every `CODELIA_*` name in source, scripts,
tools and CI after the environment-variable and debug-topic consolidation.
User-facing reference remains [`docs/reference/env-vars.md`](../docs/reference/env-vars.md).

Process chain: CLI launcher → TUI → runtime → child processes (shell, MCP,
subagents). Environment inheritance down this chain is normal and intended;
internal handoffs use CLI arguments or `initialize`, user preferences live in
config (with CLI flags where per-launch), debugging goes through
`CODELIA_DEBUG=<topics>`, and test-only hooks use the `CODELIA_TEST_*` prefix.

"Doc" marks names listed in the user-facing reference.

## 1. Internal handoff (set by Codelia for its own next process)

Not user settings. Keep out of the user reference except as "internal".

| Name | Set by → read by | Purpose | Channel |
| --- | --- | --- | --- |
| `CODELIA_DEBUG` / `CODELIA_DEBUG_DIR` = `""` | runtime → subagent child runtime | Neutralize external debug topics in child subagents | Env suppression |
| `CODELIA_NATIVE_TUI_PARENT_PID` | TUI → runtime | Native TUI client-tool identity check (compared with `ppid`) | Env (non-secret, harmless if inherited) |
| `CODELIA_UPDATE_REEXEC` | launcher → re-exec'd launcher | Re-exec marker, deleted before TUI spawn | Env (must not alter forwarded user arguments) |
| `CODELIA_ACL_TARGET` / `_OPERATION` | storage → PowerShell child | Windows ACL script input | Env (avoids shell quoting into PowerShell) |

Previously env-based handoffs now moved off the environment:
- `CODELIA_CLI_VERSION`, `CODELIA_UPDATE_NOTICE_FILE`, `CODELIA_UPDATE_CONTROL_NODE` / `_ENTRY`, `CODELIA_STARTUP_CONFIRMATIONS`, bundled `CODELIA_RUNTIME_CMD` / `_ARGS` → `--internal-launch-context=<json>`.
- TUI `--diagnostics` handoff → removed (`run.metrics` and `run.summary` are always emitted; `--diagnostics` / `CODELIA_DEBUG=diagnostics` is a TUI-local transcript toggle).

## 2. Launch overrides (developer / packaging)

| Name | Read by | Doc | Status |
| --- | --- | --- | --- |
| `CODELIA_RUNTIME_CMD` / `_ARGS` | launcher, prompt mode, TUI | Doc | Active developer/packaging override |
| `CODELIA_TUI_CMD` / `_ARGS` | launcher | Doc | Active developer/packaging override |
| `CODELIA_LANE_LAUNCH_COMMAND` | runtime lanes | — | Active |

## 3. Bootstrap (needed before config can be read)

| Name | Read by | Doc | Status |
| --- | --- | --- | --- |
| `CODELIA_CONFIG_PATH` | runtime, CLI, storage | Doc | Active |
| `CODELIA_LAYOUT` | storage | Doc | Active |
| `CODELIA_SANDBOX_ROOT` | runtime environment | Doc | Active |

## 4. Settings with config / CLI flag homes

User choices belong in config (and CLI flags when per-launch). Remaining env overrides are documented one-shot overrides:

| Name | Read by | Doc | Config / flag equivalent | Status |
| --- | --- | --- | --- | --- |
| `CODELIA_SANDBOX_MODE` | runtime | Doc | `projects.json` `sandbox_mode`, `--sandbox-mode` | Active override |
| `CODELIA_AUTH_STORAGE` | storage, test preload | Doc | `auth.storage` | Active override |
| `CODELIA_AUTO_UPDATE` | CLI, TUI | Doc | `update.mode` | Active override |
| `CODELIA_MAC_SHELL_BACKEND` | runtime | Doc | — | Active (`seatbelt` default, `mxc` opt-in on macOS arm64) |
| `CODELIA_LINUX_SHELL_BACKEND` | runtime | Doc | — | Active (`mxc` default, `gvisor` fallback on Linux) |
| `CODELIA_OPENAI_OAUTH_PORT` / `CODELIA_MCP_OAUTH_PORT` | runtime auth / MCP | Doc | — | Active loopback callback port overrides |
| `CODELIA_AGENTS_ROOT` | runtime agents/skills | Doc | — | Active repo root override |
| `CODELIA_SYSTEM_PROMPT_PATH` | runtime config | Doc | — | Active (advanced / benchmarks) |

Removed in favor of config, CLI flags, standard npm vars, or constants:
- `CODELIA_APPROVAL_MODE` / `--approval-mode` → removed (use `CODELIA_SANDBOX_MODE` / `--sandbox-mode`).
- `CODELIA_TUI_THEME`, `CODELIA_TUI_MARKDOWN_THEME` → removed (use `tui.theme` / `/theme`).
- `CODELIA_TUI_COLOR_SCHEME` → removed (use `tui.color_scheme` / `--color-scheme`, and `CODELIA_TEST_TUI_COLOR_SCHEME` in CI tests).
- `CODELIA_TUI_MODE` → removed (use `--tui-mode`).
- `CODELIA_TUI_IMAGE_PROTOCOL` → removed (use `tui.image_protocol` / `--image-protocol`).
- `CODELIA_OAUTH_BROWSER` → removed (use `auth.oauth_browser`).
- `CODELIA_AGENTS_ENABLED` → removed (use `agents.enabled` in config).
- `CODELIA_UPDATE_CHANNEL` → removed (use `update.channel`).
- `CODELIA_UPDATE_REGISTRY` → removed (use standard `npm_config_registry`).
- `CODELIA_OPENAI_OAUTH_CLIENT_ID`, `CODELIA_OPENAI_DEVICE_CODE_TIMEOUT_MS`, `CODELIA_MCP_OAUTH_TIMEOUT_MS` → inlined as constants.
- Tuning knobs (`CODELIA_AGENTS_RESOLVER_ENABLED`, `_MARKERS`, `_INITIAL_MAX_FILES`, `_INITIAL_MAX_BYTES`, `_MAX_FILES_PER_RESOLVE`, `CODELIA_READ_MAX_BYTES`, `CODELIA_READ_MAX_LINE_LENGTH`, `CODELIA_TOOL_OUTPUT_CACHE_MAX_READ_BYTES`, `_MAX_GREP_BYTES`, `_MAX_LINE_LENGTH`, `CODELIA_TOOL_OUTPUT_TOTAL_TRIM`) → inlined as constants.

## 5. Debug and diagnostics (unified)

| Name | Read by | Doc | Status |
| --- | --- | --- | --- |
| `CODELIA_DEBUG` | logger, core, storage, runtime, TUI, subagents | Doc | Single debug entry point (`1`/`true` for `debug,rpc,ws`; comma-separated topics: `debug`, `rpc`, `ws`, `perf`, `keys`, `diff`, `diagnostics`, `provider-log`, `session-dump`, `ansi-syntax`, `all`) |
| `CODELIA_DEBUG_DIR` | logger, core, TUI | Doc | Optional output directory for file-backed debug topics (`provider-log`, `keys`) |

Note: `CODELIA_DEBUG=1` and `CODELIA_DEBUG=all` intentionally exclude heavy raw disk dumps (`provider-log`, `session-dump`), which must be named explicitly.
Removed individual debug env vars folded into `CODELIA_DEBUG=<topics>`:
`CODELIA_DEBUG_PERF`, `CODELIA_DEBUG_DIFF_HIGHLIGHT`, `CODELIA_TUI_KEY_DEBUG`, `CODELIA_DIAGNOSTICS`, `CODELIA_PROVIDER_LOG`, `CODELIA_PROVIDER_LOG_DIR`, `CODELIA_SESSION_DUMP`, `CODELIA_FORCE_ANSI_SYNTAX`.

## 6. Headless and benchmark integration

| Name | Read by | Doc | Status |
| --- | --- | --- | --- |
| `CODELIA_BENCHMARK_MODE`, `CODELIA_TUI_CLIENT_TOOLS` | TUI, bench tools | — | Active |
| `CODELIA_HARBOR_SHELL_APPROVAL`, `CODELIA_ATIF_OUT`, `CODELIA_PROMPT_PROGRESS_STDERR` | CLI prompt mode, Harbor adapter | partly | Active |
| `CODELIA_TERMINAL_BENCH_RUNTIME_CMD` / `_ARGS`, `CODELIA_TERMINAL_BENCH_VIEWER_HOST` | `tools/` only | — | Tool-local |

## 7. Tests, CI and qualification only (`CODELIA_TEST_*`)

All test/CI hooks use the `CODELIA_TEST_` prefix and are kept out of the user reference:
`CODELIA_TEST_PROTOCOL_ASSERT`, `CODELIA_TEST_KEYCHAIN_DISABLED`,
`CODELIA_TEST_LIVE_KEYCHAIN`, `CODELIA_TEST_CLIPBOARD_STALL`,
`CODELIA_TEST_TUI_COLOR_SCHEME`, `CODELIA_TEST_TUI_CAPTURE_PATH`,
`CODELIA_TEST_TUI_EMULATOR_DIR`, `CODELIA_TEST_PTY_RESTORED`,
`CODELIA_TEST_MXC_HOST_SENTINEL`, `CODELIA_TEST_QUALIFICATION_PEER`,
`CODELIA_TEST_IMAGE_LIVE` / `_MODEL` / `_PROVIDER`,
`CODELIA_TEST_APPROVAL_LINUX_LIVE`, `CODELIA_TEST_STREAM_DELTA_LIVE*`, etc.

## Not environment variables

`CODELIA_CLIPBOARD_FILE_LIST` is an X11 atom name. `__CODELIA_CLI_VERSION__` is
a build-time define. `CODELIA_AUTH_KEYCHAIN_SERVICE` /
`CODELIA_MCP_AUTH_KEYCHAIN_SERVICE` are exported Keychain service-name
constants.

## Rules

1. Every new `CODELIA_*` name is registered in this file with owner, setter,
   reader and purpose; product code reads it through one typed accessor per
   package instead of scattered `process.env` / `env::var` calls (cached on hot paths).
2. User choices go to config (and a CLI flag when per-launch). Env is only a
   documented override, a bootstrap input, `CODELIA_DEBUG`, or internal handoff.
3. Internal handoff between Codelia's own processes prefers arguments or the
   `initialize` handshake so values do not leak into descendant shells/subagents.
4. Test hooks use `CODELIA_TEST_`.

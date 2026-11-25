# Environment variable inventory

**Status.** Inventory of every `CODELIA_*` name in source, scripts, tools and CI,
with a proposed disposition. User-facing reference remains
[`docs/reference/env-vars.md`](../docs/reference/env-vars.md). Section 1
(internal handoff) is implemented where marked; sections 2–8 are proposals.

Process chain: CLI launcher → TUI → runtime → child processes (shell, MCP,
subagents). Environment inheritance down this chain is normal and intended;
the problem is that names mix internal handoff, user settings, tuning knobs,
debug switches and test hooks with no stated owner or purpose.

"Doc" marks names listed in the user-facing reference.

Two kinds of use:

- **External input** (sections 2–8): a person, CI or benchmark harness sets the
  value to switch a mode, enable debugging or override a setting. Changing
  these affects user-visible behaviour, so the cleanup is deferred; most can
  move to config or flags except where a value must travel through process
  environments.
- **Internal handoff** (section 1): Codelia sets the value for its own next
  process. Most have a better channel (arguments, the `initialize` handshake,
  config read by the runtime) and can move without user-visible changes. This
  is the first cleanup step.

## 1. Internal handoff (set by Codelia for its own next process)

Not user settings. Keep out of the user reference except as "internal".

| Name | Set by → read by | Purpose | Channel |
| --- | --- | --- | --- |
| `CODELIA_CLI_VERSION` | launcher → TUI | Show CLI version | **Implemented:** `--internal-launch-context` `cli_version` |
| `CODELIA_UPDATE_NOTICE_FILE` | launcher → TUI | Startup update notices | **Implemented:** launch context `update_notice_file` |
| `CODELIA_UPDATE_CONTROL_NODE` / `_ENTRY` | launcher → TUI | `/update` control entry | **Implemented:** launch context `update_control` |
| `CODELIA_STARTUP_CONFIRMATIONS` | launcher → TUI | Private startup confirmation IDs | **Implemented:** launch context `startup_confirmations` |
| `CODELIA_RUNTIME_CMD` / `_ARGS` (handoff role) | launcher → TUI, prompt mode → runtime env | Bundled runtime location | **Implemented:** launch context `runtime {command, args}`; prompt mode no longer injects it. Env remains only as the developer override (section 2) |
| `CODELIA_DIAGNOSTICS` (handoff role) | TUI → runtime | TUI `--diagnostics` enables runtime diagnostics | **Implemented:** `initialize.ui_capabilities.supports_run_diagnostics` |
| `CODELIA_PROVIDER_LOG` / `CODELIA_DEBUG` / `CODELIA_DIAGNOSTICS` = `0` | runtime → subagent child runtime | Force child logging off | Unchanged: neutralises external input; revisit with section 6 |
| `CODELIA_NATIVE_TUI_PARENT_PID` | TUI → runtime | Native TUI client-tool identity check (compared with `ppid`) | Unchanged: not secret, harmless if inherited |
| `CODELIA_UPDATE_REEXEC` | launcher → re-exec'd launcher | Re-exec marker, deleted before TUI spawn | Unchanged: must not alter forwarded user arguments |
| `CODELIA_ACL_TARGET` / `_OPERATION` | storage → PowerShell child | Windows ACL script input | Unchanged: env avoids quoting values into a script command line |

User settings already reach other processes without environment handoff: the
runtime reads config and returns TUI-relevant values (for example `tui.theme`)
in the `initialize` result, and the TUI passes the sandbox mode as a runtime
argument. Environment forms of those settings are external overrides
(section 4), not handoff.

## 2. Launch overrides (developer / packaging)

| Name | Read by | Doc | Proposal |
| --- | --- | --- | --- |
| `CODELIA_RUNTIME_CMD` / `_ARGS` | launcher, prompt mode, TUI | Doc | Keep as developer/packaging override only (bundled handoff moved to `--internal-launch-context`) |
| `CODELIA_TUI_CMD` / `_ARGS` | launcher | Doc | Keep |
| `CODELIA_LANE_LAUNCH_COMMAND` | runtime lanes | — | Keep; document or move to `lanes` config |

## 3. Bootstrap (needed before config can be read)

| Name | Read by | Doc | Proposal |
| --- | --- | --- | --- |
| `CODELIA_CONFIG_PATH` | runtime, CLI, storage | Doc | Keep |
| `CODELIA_LAYOUT` | storage | Doc | Keep |
| `CODELIA_SANDBOX_ROOT` | runtime environment | Doc | Keep |

## 4. Settings that belong in config

Each is a user choice that already has, or should have, a config key. Env stays
only as a documented one-shot override where CI/headless use needs it.

| Name | Read by | Doc | Config equivalent | Proposal |
| --- | --- | --- | --- | --- |
| `CODELIA_SANDBOX_MODE` | runtime | Doc | `projects.json` `sandbox_mode`, CLI flag | Keep as documented override |
| `CODELIA_APPROVAL_MODE` | runtime | Doc | legacy | Deprecate with warning |
| `CODELIA_AUTH_STORAGE` | storage, test preload | — | `auth.storage` | Keep override; add to user reference |
| `CODELIA_AUTO_UPDATE` / `CODELIA_UPDATE_CHANNEL` | CLI, TUI | — | `update.mode` / `update.channel` | Keep override; add to user reference |
| `CODELIA_UPDATE_REGISTRY` | CLI | — | (npm registry) | Fold into `npm_config_registry` or document |
| `CODELIA_TUI_THEME` / `_MARKDOWN_THEME` | TUI | Doc | `tui.theme` | Deprecate env in favour of config |
| `CODELIA_TUI_COLOR_SCHEME` | TUI, CI | — | — | Add `tui.color_scheme` or document |
| `CODELIA_TUI_MODE` | TUI | — | TUI flag | Keep flag; deprecate env |
| `CODELIA_TUI_IMAGE_PROTOCOL` | TUI | — | — | Document or move to config |
| `CODELIA_MAC_SHELL_BACKEND` | runtime | Doc | — | Keep while MXC is opt-in; remove when the default changes |
| `CODELIA_OAUTH_BROWSER` | runtime auth | — | — | Document or move to config |
| `CODELIA_OPENAI_OAUTH_PORT` / `CODELIA_MCP_OAUTH_PORT` | runtime auth / MCP | MCP only | — | Unify naming; document both |
| `CODELIA_OPENAI_DEVICE_CODE_TIMEOUT_MS` / `CODELIA_MCP_OAUTH_TIMEOUT_MS` | runtime auth / MCP | MCP only | — | Unify; likely constants |
| `CODELIA_OPENAI_OAUTH_CLIENT_ID` | runtime auth | — | — | Developer-only; mark internal |

## 5. Tuning knobs (likely constants)

| Name | Read by | Doc | Proposal |
| --- | --- | --- | --- |
| `CODELIA_AGENTS_ENABLED`, `_RESOLVER_ENABLED`, `_ROOT`, `_MARKERS`, `_INITIAL_MAX_FILES`, `_INITIAL_MAX_BYTES`, `_MAX_FILES_PER_RESOLVE` | runtime agents/skills resolver | Doc | Keep `_ENABLED`/`_ROOT` as config; fold limits into constants |
| `CODELIA_READ_MAX_BYTES`, `CODELIA_READ_MAX_LINE_LENGTH` | runtime `read` | Doc | Constants |
| `CODELIA_TOOL_OUTPUT_CACHE_MAX_READ_BYTES`, `_MAX_GREP_BYTES`, `_MAX_LINE_LENGTH`, `CODELIA_TOOL_OUTPUT_TOTAL_TRIM` | storage, runtime | Doc | Constants |
| `CODELIA_SYSTEM_PROMPT_PATH` | runtime config | Doc | Keep for benchmarks; mark advanced |

## 6. Debug and diagnostics

| Name | Read by | Doc | Proposal |
| --- | --- | --- | --- |
| `CODELIA_DEBUG` | logger, core, runtime, TUI, subagents | Doc | Keep as the single debug entry point |
| `CODELIA_DEBUG_PERF`, `CODELIA_DEBUG_DIFF_HIGHLIGHT`, `CODELIA_TUI_KEY_DEBUG` | TUI | partly | Fold into `CODELIA_DEBUG=<topic,...>` |
| `CODELIA_DIAGNOSTICS` | runtime, TUI, subagents | Doc | External input (runtime reads env, TUI also accepts env as `--diagnostics`; TUI → runtime handoff moved to `initialize.ui_capabilities.supports_run_diagnostics`) |
| `CODELIA_PROVIDER_LOG`, `_DIR` | core, subagents | Doc | Fold into `CODELIA_DEBUG=provider-log` + one dir |
| `CODELIA_SESSION_DUMP` | storage | Doc | Keep |
| `CODELIA_FORCE_ANSI_SYNTAX` | TUI log wrap | — | Fold into debug topics or remove |

## 7. Headless and benchmark integration

| Name | Read by | Doc | Proposal |
| --- | --- | --- | --- |
| `CODELIA_BENCHMARK_MODE`, `CODELIA_TUI_CLIENT_TOOLS` | TUI, bench tools | — | Document together with Terminal-Bench |
| `CODELIA_HARBOR_SHELL_APPROVAL`, `CODELIA_ATIF_OUT`, `CODELIA_PROMPT_PROGRESS_STDERR` | CLI prompt mode, Harbor adapter | partly | Prefer prompt-mode flags; keep env for the adapter |
| `CODELIA_TERMINAL_BENCH_RUNTIME_CMD` / `_ARGS`, `CODELIA_TERMINAL_BENCH_VIEWER_HOST` | `tools/` only | — | Tool-local; out of product scope |

## 8. Tests, CI and qualification only

`CODELIA_PROTOCOL_ASSERT`, `CODELIA_TEST_KEYCHAIN_DISABLED`,
`CODELIA_TEST_LIVE_KEYCHAIN`, `CODELIA_TEST_CLIPBOARD_STALL`,
`CODELIA_IMAGE_LIVE` / `_MODEL` / `_PROVIDER`, `CODELIA_APPROVAL_LINUX_LIVE`,
`CODELIA_TUI_CAPTURE_PATH`, `CODELIA_TUI_EMULATOR_DIR`, `CODELIA_PTY_RESTORED`,
`CODELIA_MXC_HOST_SENTINEL`, `CODELIA_QUALIFICATION_PEER`.

Proposal: rename product-code hooks to the `CODELIA_TEST_` prefix
(`CODELIA_PROTOCOL_ASSERT` → `CODELIA_TEST_PROTOCOL_ASSERT`, etc.); never list
them in the user reference.

## Not environment variables

`CODELIA_CLIPBOARD_FILE_LIST` is an X11 atom name. `__CODELIA_CLI_VERSION__` is
a build-time define. `CODELIA_AUTH_KEYCHAIN_SERVICE` /
`CODELIA_MCP_AUTH_KEYCHAIN_SERVICE` are exported Keychain service-name
constants.

## Proposed rules

1. Every new `CODELIA_*` name is registered in this file with owner, setter,
   reader and purpose; product code reads it through one typed accessor per
   package instead of scattered `process.env` / `env::var` calls.
2. User choices go to config (and a CLI flag when per-launch). Env is only a
   documented override, a bootstrap input, debug, or internal handoff.
3. Internal handoff between Codelia's own processes prefers arguments or the
   `initialize` handshake, because environment values leak to every
   descendant. Environment is the better channel when: the value is data for a
   script (avoids quoting it into a command line); the process re-executes
   itself and must not alter the forwarded user arguments; the value is a
   secret (argv is visible to other local users); or the value must pass
   through a process Codelia does not control (npm shim, shell, multiplexer).
4. Test hooks use `CODELIA_TEST_`.
5. Deprecations print one startup warning and keep working for at least one
   minor release.

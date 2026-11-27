# Environment variables

This page lists the current user-facing environment variables for Codelia.
Most user preferences live in `config.json` (see [`config.md`](./config.md)) or
CLI flags; environment variables are reserved for provider keys, bootstrap paths,
one-shot overrides, and unified debugging.

## Auth and provider setup

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `GOOGLE_API_KEY` | Google Gemini API key (preferred) |
| `GEMINI_API_KEY` | Google Gemini API key fallback when `GOOGLE_API_KEY` is unset |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `MOONSHOT_API_KEY` | Moonshot API key |
| `MOONSHOT_BASE_URL` | Override the Moonshot API base URL |
| `ZAI_API_KEY` | Z.ai API key |
| `ZAI_BASE_URL` | Override the Z.ai API base URL |
| `XAI_API_KEY` | xAI API key |
| `XAI_BASE_URL` | Override the xAI API base URL |

## Core runtime, sandbox, and storage

| Variable | Purpose |
|---|---|
| `CODELIA_SANDBOX_ROOT` | Set the runtime working/sandbox root |
| `CODELIA_LAYOUT` | Switch storage layout to `xdg` |
| `CODELIA_CONFIG_PATH` | Override the global `config.json` path |
| `CODELIA_SANDBOX_MODE` | Select `readonly`, `workspace-write`, or `full-access` at runtime startup |
| `CODELIA_AUTH_STORAGE` | Override credential backend (`auto`, `keyring`, or `file`) |
| `CODELIA_AUTO_UPDATE` | Override update mode (`notify`, `auto`, or `off`) |
| `CODELIA_MAC_SHELL_BACKEND` | macOS arm64 shell backend override (`seatbelt` default, `mxc` opt-in) |
| `CODELIA_LINUX_SHELL_BACKEND` | Linux shell backend override (`mxc` default, `gvisor` fallback) |
| `CODELIA_AGENTS_ROOT` | Override the `AGENTS.md` / Skills repo root |
| `CODELIA_SYSTEM_PROMPT_PATH` | Override the system prompt file (advanced / benchmarks) |
| `CODELIA_ATIF_OUT` | Explicit output path for headless ATIF export; unset means no ATIF output |

## Debug and diagnostics

| Variable | Purpose |
|---|---|
| `CODELIA_DEBUG` | Unified debug topic selector. `1` / `true` enables `debug,rpc,ws`. Comma-separated topics: `debug`, `rpc`, `ws`, `perf`, `keys`, `diff`, `diagnostics`, `provider-log`, `session-dump`, `ansi-syntax`, `all` (excludes disk dumps `provider-log` and `session-dump`). |
| `CODELIA_DEBUG_DIR` | Output directory for file-backed debug topics (`provider-log`, `keys`) |

Live telemetry (TPS, TTFT, cache hits, tokens, cost, tool timing, TUI perf) is
collected automatically without setting any environment variable. In the TUI,
press `Alt+H` to cycle to the 1-line Telemetry status bar, `Alt+P` (or `/perf`)
to toggle the 2-line live footer bar, or run `/stats` (`/diag`) for the full
breakdown.

## Launch overrides and OAuth ports

| Variable | Purpose |
|---|---|
| `CODELIA_TUI_CMD` | Override the TUI executable launched by the CLI |
| `CODELIA_TUI_ARGS` | Extra args for the overridden TUI command |
| `CODELIA_RUNTIME_CMD` | Override the runtime command used by the TUI/CLI launcher |
| `CODELIA_RUNTIME_ARGS` | Override runtime arguments |
| `CODELIA_PROMPT_PROGRESS_STDERR` | Emit prompt-mode progress summaries to stderr |
| `CODELIA_OPENAI_OAUTH_PORT` | Override the local loopback callback port used by OpenAI OAuth |
| `CODELIA_MCP_OAUTH_PORT` | Override the local loopback callback port used by MCP OAuth |

Note: TUI appearance and protocol settings are configured in `config.json`
(`tui.theme`, `tui.color_scheme`, `tui.image_protocol`, `auth.oauth_browser`,
`agents.enabled`) or via CLI flags (`--tui-mode`, `--color-scheme`,
`--image-protocol`). See [`../themes.md`](../themes.md) for `/theme`.

## Example

```sh
export OPENAI_API_KEY=...
export CODELIA_LAYOUT=xdg
export CODELIA_SANDBOX_MODE=workspace-write
export CODELIA_DEBUG=perf,diagnostics
codelia
```

## Related docs

- Config reference: [`config.md`](./config.md)
- Themes: [`../themes.md`](../themes.md)
- Getting started: [`../getting-started.md`](../getting-started.md)
- TUI basics: [`../tui-basics.md`](../tui-basics.md)

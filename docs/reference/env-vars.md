# Environment variables

This page lists the most important current environment variables for Codelia.
It focuses on variables that are useful to users running the TUI and CLI.

## Auth and provider setup

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |

## Core runtime and storage

| Variable | Purpose |
|---|---|
| `CODELIA_SANDBOX_ROOT` | Set the runtime working/sandbox root |
| `CODELIA_LAYOUT` | Switch storage layout to `xdg` |
| `CODELIA_CONFIG_PATH` | Override the global `config.json` path |
| `CODELIA_APPROVAL_MODE` | Set approval mode from the environment |
| `CODELIA_SYSTEM_PROMPT_PATH` | Override the system prompt file |

## TUI and startup

| Variable | Purpose |
|---|---|
| `CODELIA_DIAGNOSTICS` | Enable run diagnostics |
| `CODELIA_DEBUG` | Enable debug logs |
| `CODELIA_DEBUG_PERF` | Enable the perf panel |
| `CODELIA_TUI_THEME` | Set the initial TUI theme |
| `CODELIA_TUI_MARKDOWN_THEME` | Legacy/fallback theme env also read by the TUI |
| `CODELIA_TUI_CMD` | Override the TUI executable launched by the CLI |
| `CODELIA_TUI_ARGS` | Extra args for the overridden TUI command |
| `CODELIA_RUNTIME_CMD` | Override the runtime command used by the TUI/CLI launcher |
| `CODELIA_RUNTIME_ARGS` | Override runtime arguments |
| `CODELIA_PROMPT_PROGRESS_STDERR` | Emit prompt-mode progress summaries to stderr |

Note: a configured theme returned from runtime config can override the env/default startup theme.
See [`../themes.md`](../themes.md) for the supported theme names and `/theme` workflow.

## AGENTS.md and Skills discovery

| Variable | Purpose |
|---|---|
| `CODELIA_AGENTS_ENABLED` | Enable or disable AGENTS loading |
| `CODELIA_AGENTS_ROOT` | Override the AGENTS/Skills repo root |
| `CODELIA_AGENTS_MARKERS` | Override root-detection markers |
| `CODELIA_AGENTS_INITIAL_MAX_FILES` | Limit initial AGENTS file count |
| `CODELIA_AGENTS_INITIAL_MAX_BYTES` | Limit initial AGENTS bytes |
| `CODELIA_AGENTS_RESOLVER_ENABLED` | Enable or disable extra path-based AGENTS resolving |
| `CODELIA_AGENTS_MAX_FILES_PER_RESOLVE` | Limit AGENTS files returned by one resolve |

## MCP

| Variable | Purpose |
|---|---|
| `CODELIA_MCP_OAUTH_PORT` | Override the local OAuth callback port used by MCP auth |
| `CODELIA_MCP_OAUTH_TIMEOUT_MS` | Override MCP OAuth wait timeout |

## Advanced diagnostics and limits

| Variable | Purpose |
|---|---|
| `CODELIA_PROVIDER_LOG` | Enable provider request/response diagnostics |
| `CODELIA_PROVIDER_LOG_DIR` | Override provider-log dump directory |
| `CODELIA_TOOL_OUTPUT_TOTAL_TRIM` | Re-enable total-budget trim of tool output cache |
| `CODELIA_READ_MAX_BYTES` | Override read-tool byte cap |
| `CODELIA_READ_MAX_LINE_LENGTH` | Override read-tool line-length cap |
| `CODELIA_TOOL_OUTPUT_CACHE_MAX_READ_BYTES` | Override cache read byte cap |
| `CODELIA_TOOL_OUTPUT_CACHE_MAX_GREP_BYTES` | Override cache grep byte cap |
| `CODELIA_TOOL_OUTPUT_CACHE_MAX_LINE_LENGTH` | Override cache line-length cap |

## Example

```sh
export OPENAI_API_KEY=...
export CODELIA_LAYOUT=xdg
export CODELIA_APPROVAL_MODE=trusted
export CODELIA_DIAGNOSTICS=1
codelia
```

## Related docs

- Config reference: [`config.md`](./config.md)
- Themes: [`../themes.md`](../themes.md)
- Getting started: [`../getting-started.md`](../getting-started.md)
- TUI basics: [`../tui-basics.md`](../tui-basics.md)

# Getting started

Codelia is primarily used through its TUI coding-agent interface.
This guide focuses on the first successful TUI session, with CLI/reference details kept secondary.

## Current status

Implemented today:
- interactive TUI launch through `codelia`
- provider auth for `openai`, `anthropic`, `openrouter`, `google`, `deepseek`, `moonshot`, `zai`, and `xai`
- session resume through `--resume`
- one-shot prompt mode through `codelia --prompt`
- MCP server management through `codelia mcp ...`

## 1. Install

Install the published CLI package globally:

```sh
npm install -g @codelia/cli
codelia --help
```

For local development in this repository:

```sh
bun install
bun run tui
```

## 2. Set up provider auth

The easiest way to sign in is directly from the TUI: launch `codelia` and follow the interactive provider and authentication prompts on your first run (or switch later with `/model`).

```sh
codelia
```

Notes:
- **OpenAI**: supports OAuth (ChatGPT Plus/Pro), device-code login (for SSH/headless shells), or an API key.
- **Anthropic, Google, DeepSeek, OpenRouter, Moonshot, Z.ai, and xAI**: currently use API-key auth.
- **Credential storage**: on macOS, Codelia stores saved credentials in macOS Keychain by default; otherwise (or when `auth.storage: "file"`) it writes them to `~/.codelia/credentials/` (or `$XDG_CONFIG_HOME/codelia/credentials/` when `CODELIA_LAYOUT=xdg`).

If macOS Keychain access times out or is denied after an update, run `codelia auth authorize-keychain` from a local terminal. See [Keychain recovery and prompt choices](reference/cli.md#macos-keychain-access-after-an-update).

### Alternative: environment variables

If you prefer not to save credentials—such as for non-interactive `codelia --prompt` runs, CI, or temporary injection from a secret manager—Codelia also works when you export a provider API key in the environment:

```sh
export OPENAI_API_KEY=...
export ANTHROPIC_API_KEY=...
export OPENROUTER_API_KEY=...
export GOOGLE_API_KEY=...    # or GEMINI_API_KEY
export DEEPSEEK_API_KEY=...
export MOONSHOT_API_KEY=...
export ZAI_API_KEY=...
export XAI_API_KEY=...
```

Environment API keys stay strictly in memory (never written to disk). If a saved credential already exists for the selected provider, saved auth takes precedence over environment variables for chat runs.

## 3. Daily TUI session

Once signed in, start the TUI anytime with:

```sh
codelia
```

On startup, the TUI connects to the runtime, loads your active provider/model state, and opens the main composer/log view.

## 4. Send your first request

Type a request in the composer and press `Enter`.
For example:

```text
Find the failing test and explain the root cause.
```

While the run is active, the log updates inline in the terminal with model output, tool activity, and status messages.

For multiline input:
- `Shift+Enter` inserts a newline when the terminal supports it.
- `Ctrl+J` is the reliable newline fallback.

## 5. Learn the core TUI commands

Inside the composer, type `/help` to see the current command list.
Common day-to-day commands include:

- `/help` — show commands
- `/model` — choose or set a model
- `/fast` — toggle model fast mode for supported models
- `/theme` — open the theme picker or save a theme choice
- `/skills` — browse available skills
- `/mcp` — inspect loaded MCP servers
- `/logout [provider]` — clear all saved model-provider credentials, or only the named provider (for example `/logout openai`), after confirmation (MCP tokens are managed separately via `codelia mcp auth`)

See [`tui-basics.md`](./tui-basics.md) for the day-to-day workflow.

## 6. Resume a previous session

Useful startup commands:

```sh
codelia --resume
codelia --resume <session_id>
codelia --initial-message "Review the latest changes"
```

What these do:
- `--resume` opens the built-in resume flow for the current worktree/workspace by default; press `A` in the picker to show all sessions.
- `--resume <session_id>` resumes a specific session.
- `--initial-message` starts the first prompt automatically after startup.

## 7. Optional: one-shot prompt mode

If you want a single non-interactive run instead of the full TUI, use prompt mode:

```sh
codelia --prompt "Summarize the repository structure"
codelia -p "Summarize the repository structure"
```

Prompt mode is useful for quick automation, but the main product workflow is the TUI.

## Next docs

- Provider guides: [DeepSeek](./deepseek.md)
- TUI basics: [`tui-basics.md`](./tui-basics.md)
- Themes: [`themes.md`](./themes.md)
- Skills: [`skills.md`](./skills.md)
- MCP: [`mcp.md`](./mcp.md)
- AGENTS.md: [`agents-md.md`](./agents-md.md)
- CLI reference: [`reference/cli.md`](./reference/cli.md)
- Config reference: [`reference/config.md`](./reference/config.md)
- Environment variables: [`reference/env-vars.md`](./reference/env-vars.md)
- User docs index: [`README.md`](./README.md)
- Developer/internal docs: [`../dev-docs/README.md`](../dev-docs/README.md)

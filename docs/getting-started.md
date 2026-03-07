# Getting started

Codelia is primarily used through its TUI coding-agent interface.
This guide focuses on the first successful TUI session, with CLI/reference details kept secondary.

## Current status

Implemented today:
- interactive TUI launch through `codelia`
- provider auth for `openai`, `anthropic`, and `openrouter`
- session resume through `--resume`
- one-shot prompt mode through `codelia --prompt`
- MCP server management through `codelia mcp ...`

Planned / not wired as a runtime provider yet:
- `google` / Gemini

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

Before the first real run, configure one of the supported providers.

Environment variables:

```sh
export OPENAI_API_KEY=...
export ANTHROPIC_API_KEY=...
export OPENROUTER_API_KEY=...
```

Or launch the TUI and follow the interactive auth prompts.

Notes:
- OpenAI supports OAuth or API key during interactive setup.
- Anthropic and OpenRouter currently use API key setup.
- By default, stored credentials live under `~/.codelia`.
- If you set `CODELIA_LAYOUT=xdg`, config/auth files move under the XDG config directory (for example `~/.config/codelia`).

## 3. Start the TUI

Launch the agent:

```sh
codelia
```

On startup, the TUI loads the runtime, resolves the current provider/model state, and shows the main composer/log view.

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
- `/theme` — open the theme picker or save a theme choice
- `/skills` — browse available skills
- `/mcp` — inspect loaded MCP servers
- `/logout` — clear the current auth session after confirmation

See [`tui-basics.md`](./tui-basics.md) for the day-to-day workflow.

## 6. Resume a previous session

Useful startup commands:

```sh
codelia --resume
codelia --resume <session_id>
codelia --initial-message "Review the latest changes"
```

What these do:
- `--resume` opens the built-in resume flow.
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

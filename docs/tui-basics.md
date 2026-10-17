# TUI basics

This page covers the day-to-day interactive workflow in the Codelia TUI.

## The main loop

A typical session looks like this:

1. Start `codelia`
2. Type a request in the composer
3. Press `Enter` to send it
4. Watch the inline log for progress, tool calls, and answers
5. Send follow-up prompts in the same session
6. Resume later with `codelia --resume`

The status line shows `TPS: 42.1` after a model response finishes. It uses the
provider's output token count and the time from the first output chunk to stream
completion, excluding the initial wait. The latest call's value stays visible
after the run and resets on the next run. No diagnostics flag is needed; if
timing or token usage is unavailable, TPS is hidden. Hidden reasoning and stream
buffering can affect comparisons between models.

## Writing prompts in the composer

Basic input behavior:
- `Enter` sends the current composer input
- `Shift+Enter` inserts a newline when supported
- `Ctrl+J` inserts a newline reliably across terminals

A good first request is short and concrete, for example:

```text
Open the failing test, explain the bug, and propose the smallest fix.
```

## Slash commands

Slash commands are part of the normal TUI workflow.
Type `/` in the composer to see suggestions.

Common commands:
- `/help` — print the command list in the log
- `/model [provider/]name` — switch model or open the picker
- `/fast [on|off|toggle]` — toggle provider-specific model fast mode
- `/theme [theme-name]` — open the theme picker or set a theme directly
- `/context [brief]` — inspect current context state
- `/skills [query]` — browse skills
- `/mcp [server-id]` — inspect loaded MCP servers
- `/logout [provider]` — sign out of all providers, or only the named provider, after confirmation

Type `/theme` with no argument to open the picker, or use a name such as `/theme rose` to apply and save a theme directly.

There are more commands than the list above; `/help` is the fastest way to discover the current surface.

## Useful interaction patterns

### Ask for scoped work

The TUI works best when you tell it what to inspect and what output you want.
Examples:

```text
Check the last changes in packages/runtime and tell me if there is a regression.
```

```text
Update the README for the new MCP flow and keep the diff minimal.
```

### Iterate in the same session

After the first answer, keep going in the same conversation:
- ask for a smaller diff
- ask for a test
- ask for a review
- ask it to explain the change before editing

## Session resume

Resume commands:

```sh
codelia --resume
codelia --resume <session_id>
```

Use resume when you want to continue the same thread of work instead of starting from scratch.
The built-in picker shows sessions from the current worktree/workspace by default, and you can press `A` in the picker to switch to all saved sessions.

## Startup flags worth remembering

```sh
codelia --diagnostics
codelia --approval-mode trusted
codelia --initial-message "Review the latest diff"
```

What they do:
- `--diagnostics` enables per-call LLM diagnostics
- `--approval-mode` sets the runtime approval policy
- `--initial-message` queues the first prompt immediately at startup

## Related docs

- Getting started: [`getting-started.md`](./getting-started.md)
- Themes: [`themes.md`](./themes.md)
- AGENTS.md: [`agents-md.md`](./agents-md.md)
- Skills: [`skills.md`](./skills.md)
- MCP: [`mcp.md`](./mcp.md)
- CLI reference: [`reference/cli.md`](./reference/cli.md)
- User docs index: [`README.md`](./README.md)

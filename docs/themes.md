# Themes

Codelia includes built-in TUI themes, and theme switching is part of the normal interactive workflow.
This page covers how to change the theme, which names are currently supported, and what gets saved.

## Fastest way: `/theme`

Inside the TUI composer:
- `/theme` opens the theme picker
- `/theme ocean` applies and saves a specific theme directly

The picker marks the current theme and lets you apply a new one with `Enter`.

## Supported theme names

The current built-in theme names are:

| Theme | Description | Aliases |
|---|---|---|
| `codelia` | warm amber accents (default) | `amber` |
| `ocean` | cool blue accents | - |
| `forest` | calm green accents | - |
| `rose` | dusty rose accents | `rose-gold`, `rosegold` |
| `sakura` | light pink accents | - |
| `mauve` | soft violet accents | - |
| `plum` | deep purple accents | - |
| `iris` | indigo accents | - |
| `crimson` | rich red accents | `crimson-mist`, `crimsonmist` |
| `wine` | wine-magenta accents | `wine-steel`, `winesteel` |

## Config and environment

You can also choose the startup theme outside the picker.

Config example:

```json
{
  "version": 1,
  "tui": {
    "theme": "forest"
  }
}
```

Environment example:

```sh
CODELIA_TUI_THEME=ocean codelia
```

Notes:
- `CODELIA_TUI_MARKDOWN_THEME` is still read as a legacy/fallback env var.
- At startup, a configured `tui.theme` overrides the env/default theme selection.

## Where theme changes are saved

When you change the theme from the TUI, Codelia saves it for future launches.

Current behavior:
- if there is no existing project theme override, the saved theme goes to the global config
- if the project config already defines `tui.theme`, later `/theme` changes stay project-scoped

See [`reference/config.md`](./reference/config.md) for config file locations.

## Current limitation

Theme changes update the TUI colors immediately, but syntax highlighting for markdown/code blocks keeps the startup theme until you restart the TUI.

## Related docs

- TUI basics: [`tui-basics.md`](./tui-basics.md)
- Getting started: [`getting-started.md`](./getting-started.md)
- Config reference: [`reference/config.md`](./reference/config.md)
- Environment variables: [`reference/env-vars.md`](./reference/env-vars.md)
- User docs index: [`README.md`](./README.md)

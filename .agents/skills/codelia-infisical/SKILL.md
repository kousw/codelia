---
name: codelia-infisical
description: Run Codelia development commands with API keys injected by Infisical. Use for local provider smoke tests, live integration tests, TUI runs, or other development commands that need secrets.
---

# Codelia development keys via Infisical

Use Infisical as the source of development API keys and inject them into the command that needs them. Commands that need no secrets can run directly.

## Setup

- Work from the Codelia repository root, where the local `.infisical.yaml` links this checkout to its Infisical project. This file is git-ignored by repository policy.
- Check that the CLI is available with `infisical --version`. If unavailable, report the prerequisite instead of installing it automatically.
- For an unlinked checkout, authenticate with `infisical login`, then run `infisical init` and select the Codelia development project. Reuse an existing `.infisical.yaml`; do not reinitialize it or replace its project/environment settings.
- Authentication or project access failures require fixing that prerequisite. Do not fall back to local `.env` credentials.

## Run commands

Wrap the intended command with `infisical run --env=dev --`. Use the project's actual development environment slug and folder when they differ; `dev` and `/` are examples. Select a secret folder with `--path=/folder`. Keep the `--` separator so command flags go to the child process.

```sh
# TUI with development keys
infisical run --env=dev -- bun run tui

# Only when live integration execution is intended
INTEGRATION=1 CODELIA_DEEPSEEK_LIVE=1 infisical run --env=dev -- bun test packages/runtime/tests/deepseek-live.test.ts --test-name-pattern "deepseek-flash stateless"
```

For another smoke script or test, replace the child command with the intended command and check its additional opt-in flags. Keep project scripts in the `bun run <script>` form. Live API tests remain opt-in via `INTEGRATION=1`; secret injection alone does not opt them in or authorize new live calls. The example selects Flash only; omit the name filter when both DeepSeek models are intended.

## Key inventory and handling

- Infisical holds the current inventory. Examples provided at adoption were `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, and `TYPESAFE_API_KEY`. This is an illustrative snapshot, not an exhaustive list or a runtime provider support declaration.
- New development keys belong in Infisical using the environment-variable names expected by their consumers. Do not maintain a hardcoded allowlist or require a skill edit whenever keys are added.
- Check the consumer for the required variable name, then let Infisical inject it. If needed, check only presence inside the child process and report variable names or booleans, never values.
- Keep values out of source, documentation, command arguments, logs, and tool output. Do not dump the environment, list raw secret values, export secrets to `.env`, or copy values into manual `export` commands.
- If a required key is missing or inaccessible, report the variable name and environment/folder needed; do not substitute another key or silently change authentication.

Reference: [Infisical project configuration](https://infisical.com/docs/cli/project-config). For installed-version command details, use `infisical run --help` and `infisical init --help`.

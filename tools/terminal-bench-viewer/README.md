# Terminal-Bench Viewer

Local web viewer for Harbor job results under a configured `jobs_dir`.

## What it shows

- job list with search / status / model filters
- task aggregate table with sortable success-rate / recent-window / execution-time columns
- primary job + compare job selection
- per-task result table with diff-focused ordering
- selected task history across past jobs
- task-level recent N runs or recent days window, with delta columns for regression checks

## API

- machine-readable discovery: `GET /api/schema`
- human-readable reference: [`API.md`](./API.md)
- intended flow for agents: `schema -> config -> jobs -> tasks/history`
- includes direct `curl` / `fetch` calling examples for local automation

## Config

- `config.json`: committed defaults
- `config.local.json`: optional local override, ignored by git

Minimum config:

```json
{
  "jobs_dir": "../../tmp/terminal-bench/jobs"
}
```

Local override example:

```json
{
  "jobs_dir": "/home/you/work/codelia/tmp/terminal-bench/jobs"
}
```

## Dev

```bash
bun run --filter @codelia/terminal-bench-viewer dev
```

Or from repo root:

```bash
bun run terminal-bench:viewer
```

## Build

```bash
bun run --filter @codelia/terminal-bench-viewer build
```

# basic-web

Agentic web chat example for Codelia. A React SPA with SSE streaming, tool call visualization, and multi-turn session persistence.

> [!WARNING]
> This example is **not production-ready**.
> It has some security issues but it is intended as a useful sample implementation for agentic web/server infrastructure patterns (for example: API/Worker separation, Postgres-backed durable runs, and SSE tailing).

## Setup

```bash
# From repo root
bun install
bun run --filter '@codelia/*' build

# Set your API key
export OPENAI_API_KEY=sk-...
# or
export ANTHROPIC_API_KEY=sk-ant-...
```

## Development

```bash
cd examples/basic-web
bun run dev
```

This starts:
- **Hono server** on `http://localhost:3001` (API + SSE)
- **Vite dev server** on `http://localhost:3000` (React SPA, proxies `/api/` to 3001)

Open http://localhost:3000 in your browser.

With Postgres durable runs, split startup example:

```bash
# API process
DATABASE_URL=postgres://... bun run dev:api

# Worker process (separate shell)
DATABASE_URL=postgres://... bun run dev:worker
```

Or run both together with Vite:

```bash
DATABASE_URL=postgres://... bun run dev:durable
```

## Docker Compose

```bash
cd examples/basic-web
docker compose up --build
```

Starts:
- `postgres` (`localhost:5432`)
- `api` (`localhost:3001`, `CODELIA_RUN_ROLE=api`)
- `worker` (no published port, `CODELIA_RUN_ROLE=worker`)
- `web` (`localhost:3000`, Vite dev server proxying `/api` to `api:3001`)

Optional envs when starting compose:

```bash
OPENAI_API_KEY=... \
ANTHROPIC_API_KEY=... \
CODELIA_OPENAI_OAUTH_PUBLIC_BASE_URL=http://localhost:3001 \
CODELIA_OPENAI_OAUTH_CLIENT_ID=app_... \
WEB_PORT=3000 \
API_PORT=3001 \
POSTGRES_PORT=5432 \
docker compose up --build
```

Note:
- `CODELIA_OPENAI_OAUTH_PUBLIC_BASE_URL` is optional. If unset, OAuth uses loopback callback mode.
- `CODELIA_OPENAI_OAUTH_CLIENT_ID` is optional. If unset or empty, the built-in default client id is used.
- Public callback mode should be used with a client id that is configured to accept the callback URL.

### Multi-instance (Traefik LB)

To reproduce LB + multi-instance behavior locally:

```bash
cd examples/basic-web
docker compose -f docker-compose.multi.yml up --build --scale api=2 --scale worker=2
```

This starts:
- `api` x2 (no direct host publish)
- `worker` x2
- `lb` (`traefik` file-provider, publishes `localhost:3001`)
- `web` (`localhost:3000`)
- `postgres` (`localhost:5432`)

Notes:
- In this profile, OAuth uses public callback mode via `http://localhost:3001` (through Traefik).
- If host `5432` is occupied, use `POSTGRES_PORT=55432`.
- This profile is a standalone compose file (do not combine with `docker-compose.yml`).

## Features

- Session sidebar with create/select/delete
- Real-time SSE streaming of agent responses (`/api/runs/:run_id/events`)
- Reload-safe resume: auto-detects active (`queued/running`) run and re-subscribes SSE
- Tool call cards with collapsible args/results
- Reasoning block display (collapsible)
- Session persistence via `SessionStateStoreImpl`
- Per-session Agent instances with idle eviction (30 min)
- Sandbox-scoped tools: bash, read, write, edit, glob_search, grep

## Architecture

```
Browser (React SPA)                    Server (Hono + Bun)
┌─────────────────┐  POST /api/runs    ┌──────────────────────┐
│  useChat hook    │ ─────────────────> │  RunManager (phase0) │
│  create + stream │ GET /events (SSE) │  AgentPool           │
│  Last-Event-ID   │ <───────────────── │  SessionManager      │
│  useSessions     │ ── REST ────────> │  SessionStateStore   │
└─────────────────┘                    └──────────────────────┘
```

With `DATABASE_URL` set, runs are persisted in Postgres (`runs`, `run_events`) and a worker loop claims queued runs.
Session state and settings/auth are also persisted in Postgres.
`CODELIA_RUN_ROLE=api|worker|all` allows separating API and worker processes.

## Environment Variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key (if using openai provider) |
| `ANTHROPIC_API_KEY` | Anthropic API key (if using anthropic provider) |
| `CODELIA_CONFIG_PATH` | Custom config.json path |
| `CODELIA_SANDBOX_ROOT` | Root directory for sandbox |
| `CODELIA_SANDBOX_TTL_SECONDS` | TTL seconds for inactive session sandbox directories (default: `43200`) |
| `CODELIA_SESSION_STICKY_TTL_SECONDS` | Worker sticky lease TTL per session in durable mode (default: `600`) |
| `CODELIA_SYSTEM_PROMPT_PATH` | Custom system prompt file |
| `DATABASE_URL` | Postgres connection string for durable runs (`runs`, `run_events`) |
| `CODELIA_RUN_ROLE` | `all` (default), `api`, or `worker` |
| `CODELIA_OPENAI_OAUTH_PUBLIC_BASE_URL` | Enables public OAuth callback mode (`<base>/api/settings/openai/oauth/callback`) with DB `oauth_state` |
| `CODELIA_OPENAI_OAUTH_CLIENT_ID` | Optional OpenAI OAuth client id. Empty/unset falls back to the default built-in client id |
| `CODELIA_OPENAI_OAUTH_PORT` | Loopback callback port for OAuth local mode (default: `1455`) |
| `PORT` | Server port (default: 3001) |

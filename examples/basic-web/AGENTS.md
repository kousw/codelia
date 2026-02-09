# basic-web

## Purpose
- Minimal web chat implementation for React + Hono.
- Deliver events for `entry.agent.runStream()` to the UI via SSE.

## Key Notes
- SSE reception by the client is processed by the `src/client/api.ts` frame unit parser (`\n\n` delimited).
- The standard execution path for the UI is `POST /api/runs` + `GET /api/runs/:runId/events`, followed by reconnection using `Last-Event-ID`.
- The information under server is organized in a functional hierarchy (`agent/`, `config/`, `runs/`, `sessions/`, `settings/`, `runtime/`, `routes/`).
- `src/server/runs/run-manager.ts` maintains in-memory run/event log as phase0 (`/api/chat/:sessionId` is maintained for backward compatibility).
- When `DATABASE_URL` is set, `src/server/runs/postgres-run-manager.ts` is enabled and `runs`/`run_events` treat Postgres as the source of truth.
- When `DATABASE_URL` is set, `sessions` and settings store are also switched to the Postgres implementation (`src/server/sessions/postgres-session-manager.ts`, `src/server/settings/postgres-settings-store.ts`).
- Responsibilities can be separated using `CODELIA_RUN_ROLE=api|worker|all`. `api` only enqueue/SSE, `worker` only claim/run execution, `all` runs both.
- sandbox creates a separate directory (`session-<slug>-<hash>`) for each session under `CODELIA_SANDBOX_ROOT`.
- sandbox automatically deletes inactive session directories on `CODELIA_SANDBOX_TTL_SECONDS` (default 12h).
- In Postgres durable mode, `worker_session_leases` is used to prioritize runs in the same session to the same worker (`CODELIA_SESSION_STICKY_TTL_SECONDS`, default 10m).
- If `CODELIA_OPENAI_OAUTH_PUBLIC_BASE_URL` is set, OAuth uses public callback (`/api/settings/openai/oauth/callback`) + `oauth_state` DB management. If not set, conventional loopback callback is used.
- compose By default, `CODELIA_OPENAI_OAUTH_PUBLIC_BASE_URL` is empty, and public callbacks are only enabled when explicitly specified.
- When `CODELIA_OPENAI_OAUTH_CLIENT_ID` is unset/empty string, it falls back to the default client id of `openai-oauth.ts` (even empty string injection in compose does not change to `client_id=`).
- If the connection ends without receiving `done/error`, treat it as `error` and release the UI streaming state without fail.
- `loadHistory` of `src/client/hooks/useChat.ts` reconfigures and restores `reasoning` / `assistant.tool_calls` / `tool` of session history to UI event. Empty `assistant` (`content=null` only) is not displayed.
- `src/client/hooks/chat-history.ts` is in charge of pure conversion logic for history restoration (history → UI events), and `useChat` is in charge of run restart judgment and SSE subscription control.
- `loadHistory` of `src/client/hooks/useChat.ts` re-detects the active run in `GET /api/runs?session_id=...&statuses=queued,running&limit=1` and automatically resumes SSE resubscription even after reload (if necessary, complete `input_text` on the user side).
- Use `docker-compose.multi.yml` (single file) for multiple startup verification under LB (Traefik front stage + `--scale api=2 --scale worker=2`, Traefik settings are `traefik/dynamic.yml`).
- Server `src/server/routes/chat.ts` monitors `c.req.raw.signal` and aborts the run when disconnected.
- Since `src/server/routes/chat.ts` outputs request lifecycle logs (start/first event/done/error/finish), give priority to server logs when isolating connection problems.
- Authentication/model settings are managed by `src/server/routes/settings.ts` (`/api/settings`) and `src/server/settings/settings-store.ts`. When updating the settings, use `AgentPool.invalidateAll()` to discard the existing agent and apply the new settings from the next run.
- The settings are saved in the local file `basic-web.settings.json` (under the storage config dir), and the API key returns only the masked preview to the UI.
- OpenAI OAuth starts and executes the local callback server (default `localhost:1455/auth/callback`) where `/api/settings/openai/oauth/start` of `src/server/routes/settings.ts` is `src/server/config/openai-oauth.ts`.
- Since OpenAI OAuth sessions are in-memory, it is necessary to re-authenticate after restarting the server. Callback port can be changed with `CODELIA_OPENAI_OAUTH_PORT`.
- OpenAI OAuth token refresh is executed in OpenAI clientOptions of `src/server/config/config.ts`, and the refresh token is saved again to `SettingsStore.saveOpenAiOAuth` via `AgentPool`.
- When running OpenAI OAuth, use `OPENAI_OAUTH_BASE_URL` (`chatgpt.com/backend-api/codex`), and if `account_id` is present, add the `ChatGPT-Account-Id` header.
- UI styles are consolidated into `src/client/styles.css`. In principle, new components are added on a class basis.
- Implemented: Chat composer has slash commands (`/new` `/cancel` `/clear` `/help`).
- Planned: add more TUI command parity to the web UI.
- The status strip under the Chat header displays the run status and execution time (in progress/recently completed).
- `POST /api/sessions` immediately saves an empty session. `new chat` Do not remove this save to avoid a problem where you cannot list/restore it later.
- `SessionManager.delete` physically deletes the state file. Behavior that deletes the entity rather than hiding it on display.

## Local Dev
- `cd examples/basic-web && bun run dev`
- quality checks: `cd examples/basic-web && bun run lint|check|fmt|typecheck`
- Durable mode: `DATABASE_URL=... bun run dev:durable` (api+worker+vite start at the same time)
- Separate startup: `DATABASE_URL=... bun run dev:api` / `DATABASE_URL=... bun run dev:worker`
- Docker Compose: `cd examples/basic-web && docker compose up --build`（postgres/api/worker/web）
- Multi-instance Compose: `cd examples/basic-web && docker compose -f docker-compose.multi.yml up --build --scale api=2 --scale worker=2`
- `bun run --filter '@codelia/basic-web' build`

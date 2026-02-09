# basic-web

## Purpose
- React + Hono の最小 Web チャット実装。
- SSE 経由で `entry.agent.runStream()` のイベントを UI に配信する。

## Key Notes
- クライアントの SSE 受信は `src/client/api.ts` のフレーム単位パーサ（`\n\n` 区切り）で処理する。
- UI の標準実行経路は `POST /api/runs` + `GET /api/runs/:runId/events` で、`Last-Event-ID` を使った再接続を行う。
- server 配下は機能別階層（`agent/`, `config/`, `runs/`, `sessions/`, `settings/`, `runtime/`, `routes/`）で整理している。
- `src/server/runs/run-manager.ts` は phase0 として in-memory の run/event log を保持する（`/api/chat/:sessionId` は後方互換で維持）。
- `DATABASE_URL` が設定されると `src/server/runs/postgres-run-manager.ts` が有効化され、`runs`/`run_events` を Postgres 正本として扱う。
- `DATABASE_URL` が設定されると `sessions` と `settings/auth` も Postgres 実装（`src/server/sessions/postgres-session-manager.ts`, `src/server/settings/postgres-settings-store.ts`）に切り替わる。
- `CODELIA_RUN_ROLE=api|worker|all` で責務分離できる。`api` は enqueue/SSE のみ、`worker` は claim/run 実行のみ、`all` は同居。
- sandbox は `CODELIA_SANDBOX_ROOT` 配下で session ごとに分離ディレクトリ（`session-<slug>-<hash>`）を作成する。
- sandbox は `CODELIA_SANDBOX_TTL_SECONDS`（既定 12h）で非アクティブ session ディレクトリを自動削除する。
- Postgres durable モードでは `worker_session_leases` を使って同一 session の run を同一 worker へ優先配分する（`CODELIA_SESSION_STICKY_TTL_SECONDS`, 既定 10m）。
- `CODELIA_OPENAI_OAUTH_PUBLIC_BASE_URL` が設定されると OAuth は公開 callback (`/api/settings/openai/oauth/callback`) + `oauth_state` DB 管理を使う。未設定時は従来 loopback callback を使う。
- compose デフォルトでは `CODELIA_OPENAI_OAUTH_PUBLIC_BASE_URL` を空にしてあり、公開 callback は明示指定時のみ有効。
- `CODELIA_OPENAI_OAUTH_CLIENT_ID` は未設定/空文字のとき `openai-oauth.ts` のデフォルト client id にフォールバックする（compose の空文字注入でも `client_id=` にならない）。
- `done/error` が来ないまま接続終了した場合は `error` 扱いにして UI の streaming 状態を確実に解放する。
- `src/client/hooks/useChat.ts` の `loadHistory` は session history の `reasoning` / `assistant.tool_calls` / `tool` を UI event に再構成して復元する。空 `assistant` (`content=null` only) は表示しない。
- `src/client/hooks/chat-history.ts` は履歴復元（history → UI events）の純粋変換ロジックを担当し、`useChat` は run 再開判定と SSE 購読制御を担当する。
- `src/client/hooks/useChat.ts` の `loadHistory` は `GET /api/runs?session_id=...&statuses=queued,running&limit=1` で active run を再検出し、リロード後も SSE 再購読を自動再開する（必要なら `input_text` を user 側へ補完）。
- LB 下の多重起動検証は `docker-compose.multi.yml`（単独ファイル）を使う（Traefik 前段 + `--scale api=2 --scale worker=2`、Traefik 設定は `traefik/dynamic.yml`）。
- サーバー `src/server/routes/chat.ts` は `c.req.raw.signal` を監視し、切断時に run を abort する。
- `src/server/routes/chat.ts` は request lifecycle ログ（start/first event/done/error/finish）を出すため、接続不具合の切り分けはサーバーログを優先する。
- 認証/モデル設定は `src/server/routes/settings.ts` (`/api/settings`) と `src/server/settings/settings-store.ts` で管理。設定更新時は `AgentPool.invalidateAll()` で既存 agent を破棄し、次 run から新設定を適用する。
- settings はローカルファイル `basic-web.settings.json`（storage config dir 配下）に保存され、API key は mask した preview のみ UI に返す。
- OpenAI OAuth は `src/server/routes/settings.ts` の `/api/settings/openai/oauth/start` が `src/server/config/openai-oauth.ts` のローカル callback サーバー（デフォルト `localhost:1455/auth/callback`）を起動して実行する。
- OpenAI OAuth セッションは in-memory のため、サーバー再起動後は認証をやり直す必要がある。`CODELIA_OPENAI_OAUTH_PORT` で callback ポート変更可。
- OpenAI OAuth token refresh は `src/server/config/config.ts` の OpenAI clientOptions 内で実行し、更新tokenは `AgentPool` 経由で `SettingsStore.saveOpenAiOAuth` に再保存される。
- OpenAI OAuth 実行時は `OPENAI_OAUTH_BASE_URL` (`chatgpt.com/backend-api/codex`) を使い、`account_id` がある場合は `ChatGPT-Account-Id` ヘッダを付与する。
- UI スタイルは `src/client/styles.css` に集約。新規コンポーネントは原則クラスベースで追加する。
- Chat composer は slash command を持つ（`/new` `/cancel` `/clear` `/help`）。TUI のコマンド操作を web でも最低限再現する方針。
- Chat header 下の status strip は run 状態と実行時間（進行中/直近完了）を表示する。
- `POST /api/sessions` は空セッションを即保存する。`new chat` 後に一覧/復元できない不具合を避けるため、この保存を外さないこと。
- `SessionManager.delete` は state ファイルを物理削除する。表示上の非表示ではなく実体を削除する挙動。

## Local Dev
- `cd examples/basic-web && bun run dev`
- quality checks: `cd examples/basic-web && bun run lint|check|fmt|typecheck`
- Durable mode: `DATABASE_URL=... bun run dev:durable`（api+worker+vite 同時起動）
- 分離起動: `DATABASE_URL=... bun run dev:api` / `DATABASE_URL=... bun run dev:worker`
- Docker Compose: `cd examples/basic-web && docker compose up --build`（postgres/api/worker/web）
- Multi-instance Compose: `cd examples/basic-web && docker compose -f docker-compose.multi.yml up --build --scale api=2 --scale worker=2`
- `bun run --filter '@codelia/basic-web' build`

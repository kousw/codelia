# Auth / Credential Spec

This document defines how codelia stores and uses provider credentials.

## 0. Implementation status (as of 2026-02-09)

Implemented:
- Runtime provider auth resolution for `openai` / `anthropic`
- Local `auth.json` read/write (`0600` where possible)
- OpenAI OAuth via loopback callback (`http://localhost:<port>/auth/callback`)
- UI-driven auth prompts (`ui.pick.request` / `ui.prompt.request` / `ui.confirm.request`)

Planned:
- Additional providers such as OpenRouter/Gemini
- Production OAuth callback flow with external callback + DB-managed `oauth_state`

## 1. Goals

- Support per-provider credentials (API key or OAuth) without relying on env vars.
- Store credentials in a local file (`auth.json`) with minimal surface area.
- Allow TUI to prompt for missing credentials (CLI later).
- Keep provider-specific auth logic isolated.

## 2. Storage location

Use the storage paths defined in `docs/specs/storage-layout.md`:

- Default: `~/.codelia/auth.json`
- XDG layout (opt-in): `$XDG_CONFIG_HOME/codelia/auth.json`

Security expectations:

- Create the file with permissions `0600` when possible.
- Never print secrets in logs or UI events.
- Future: allow keychain/secret-store replacement.

## 3. auth.json format (v1)

```json
{
  "version": 1,
  "providers": {
    "openai": {
      "method": "oauth",
      "oauth": {
        "access_token": "...",
        "refresh_token": "...",
        "expires_at": 1730000000000,
        "account_id": "..."
      }
    },
    "anthropic": {
      "method": "api_key",
      "api_key": "sk-ant-..."
    }
  }
}
```

Notes:

- `expires_at` is epoch milliseconds.
- `account_id` is optional (used for OpenAI subscription headers).
- Env vars remain a fallback but should not overwrite stored auth unless explicitly requested.

## 4. Provider support matrix (v1)

- OpenAI
  - `method: oauth` (ChatGPT Plus/Pro subscription)
  - `method: api_key` (standard OpenAI API key)
- Anthropic
  - `method: api_key` only
- OpenRouter (Planned)
  - `method: api_key` only

## 5. OAuth flow (OpenAI)

Use an OAuth 2.0 Authorization Code flow with PKCE.

Profile-specific callback strategy:

- `dev-local` (Implemented):
  - Loopback callback server is allowed (for local development ergonomics).
- `prod` (Planned):
  - Public callback URL is required.
  - OAuth `state` and PKCE verifier must be stored in DB (`oauth_state`) with TTL.
  - Callback handler must validate and one-time consume `state` from DB.

High-level flow:

1. Generate PKCE verifier/challenge and create `state`.
2. Persist OAuth state metadata (`state`, verifier, expires_at, provider, redirect_uri).
3. Open browser to the OpenAI authorization URL with PKCE params.
4. Receive `code` at callback (loopback in dev-local, public endpoint in prod).
5. Validate `state` and one-time consume it from storage.
6. Exchange `code` for access + refresh tokens.
7. Persist tokens in auth storage.
8. Refresh tokens when expired.

Runtime usage:

- Use `access_token` as `Authorization: Bearer <token>`.
- If available, send `ChatGPT-Account-Id: <account_id>`.
- Requests may need a different OpenAI endpoint for subscription usage
  (implementation detail, provider-specific).

## 6. Runtime selection & UI flow (TUI only for now)

When auth is missing for the selected provider:

1. Prompt for provider (`ui.pick.request` if supported).
2. Prompt for auth method (OAuth or API key) with provider-specific options.
3. If API key: prompt for input (`ui.prompt.request`, masked in TUI if possible).
4. If OAuth:
   - Implemented: dev-local loopback callback server + browser auth URL.
   - Planned: prod flow with public callback + DB-managed oauth state.
5. Persist on success; show failure reason on error.

If UI does not support prompts/picks, runtime should return a clear error.

## 7. Error handling

- Missing/invalid credentials: return a provider auth error and stop the run.
- OAuth timeout/cancel: user-facing error; do not reuse partial tokens.
- Token refresh failure: clear stored tokens and restart auth flow.

## 8. Future items

- CLI auth flow (mirror TUI prompts).
- Keychain/secret-store backend.
- Gemini support (after OpenRouter, per roadmap).

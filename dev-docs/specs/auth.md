# Auth / Credential Spec

This document defines how codelia stores and uses provider credentials.

## 0. Implementation status (as of 2026-07-17)

Implemented:
- Runtime provider auth resolution for `openai` / `anthropic` / `openrouter` / `moonshot` / `zai`
- Local `auth.json` read/write (`0600` where possible)
- OpenAI OAuth via loopback callback (`http://localhost:<port>/auth/callback`)
- OpenAI device-code login for SSH/headless environments
- SSH-aware manual browser fallback for loopback OAuth (`CODELIA_OAUTH_BROWSER=manual`, auto-enabled when SSH env is detected, supports pasted callback URL/code)
- UI-driven auth prompts (`ui.pick.request` / `ui.prompt.request` / `ui.confirm.request`)

Planned:
- Startup-triggered first-run onboarding for no-auth users (TUI)
- Friendly onboarding copy for first-run auth and model selection steps
- Additional providers such as Gemini
- Production OAuth callback flow with external callback + DB-managed `oauth_state`

## 1. Goals

- Support per-provider credentials (API key or OAuth) without relying on env vars.
- Store credentials in a local file (`auth.json`) with minimal surface area.
- Allow TUI to prompt for missing credentials (CLI later).
- Keep provider-specific auth logic isolated.

## 2. Storage location

Use the storage paths defined in `dev-docs/specs/storage-layout.md`:

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
- OpenRouter
  - `method: api_key` only
- Moonshot
  - `method: api_key` only
- Z.ai
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

Notes:

- OpenAI device-code login is implemented through the Codex-style `/api/accounts/deviceauth/*` flow.
- Over SSH, manual mode can complete by pasting the redirected callback URL (or `code=...&state=...`) back into the TUI.

Runtime usage:

- Use `access_token` as `Authorization: Bearer <token>`.
- If available, send `ChatGPT-Account-Id: <account_id>`.
- Requests may need a different OpenAI endpoint for subscription usage
  (implementation detail, provider-specific).

## 6. First-run onboarding & runtime auth flow (TUI only for now)

### 6.1 First-run onboarding trigger (Planned)

Start onboarding immediately on TUI startup when all of the following are true:

- `auth.json` has no provider credentials for supported providers.
- No supported provider API key env vars are available (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`).

If at least one provider credential exists (stored or env), runtime may skip onboarding and proceed with normal run flow.

### 6.2 Friendly messaging policy (Planned)

Onboarding text should be short, clear, and friendly (no jargon-heavy copy).

- Welcome copy should explain what happens next.
- Provider options should include a one-line detail about auth method and recommended usage.
- Auth method copy should explain OAuth vs API key in plain language.
- Errors should be actionable and calm (for example, suggest retry or selecting a different method).

Example tone:
- "Let's set up your AI provider to get started."
- "You can switch this later from settings/commands."

### 6.3 Onboarding flow for missing auth

When auth is missing for the selected provider:

1. Prompt for provider (`ui.pick.request` if supported).
   - Include per-provider `detail` text in pick items.
2. Prompt for auth method (OAuth or API key) with provider-specific options.
3. If API key: prompt for input (`ui.prompt.request`, masked in TUI if possible).
4. If OAuth:
   - Implemented: OpenAI device-code flow for SSH/headless usage.
   - Implemented: dev-local loopback callback server + browser auth URL.
   - Implemented: SSH sessions default to manual browser instructions instead of attempting remote browser launch, and can finish by pasting the redirected callback URL/code into the UI.
   - Planned: prod flow with public callback + DB-managed oauth state.
5. Persist on success; continue to model selection step in onboarding.
6. Show failure reason on error.

### 6.4 Model selection step after auth (Planned)

After successful auth in first-run onboarding:

1. Request model candidates with `model.list` for the selected provider.
2. Show model picker immediately.
3. Persist selected model with `model.set`.

If UI does not support prompts/picks, runtime should return a clear error.

## 7. Error handling

- Missing/invalid credentials: return a provider auth error and stop the run.
- OAuth timeout/cancel: user-facing error; do not reuse partial tokens.
- Token refresh failure: clear stored tokens and restart auth flow.

### 7.1 Named logout (Implemented 2026-10-07)

`/logout [provider]` uses `auth.logout.provider` to remove one saved provider entry,
including named Responses endpoints. Omitted provider preserves all-provider
removal. Local deletion requires confirmation; invalid or unknown names leave auth
untouched. Known configured providers without saved credentials are a harmless
no-op; stored entries remain removable after endpoint config is deleted.

Only logout affecting the current provider invalidates its agent; `clear_session`
defaults to true but resets only a matching current session for scoped requests.
Other-provider credentials, agents and sessions remain intact. This removes saved
auth only, without remote revocation or changes to environment variables.

TUI checks `supports_scoped_logout` before named requests because older servers
could otherwise ignore the name and remove all auth. Embedded hosts require
`CredentialProvider.clearProviderAuth(provider)`; scoped requests never fall back
to all-provider `clearAuth()`. Credential v2 migration/write coordination below is
still proposed and is not introduced by scoped logout.

## 8. Future items

- CLI auth flow (mirror TUI prompts).
- Keychain/secret-store backend.
- Gemini support (per roadmap).

## 9. Credential coexistence for image generation (Proposed)

Status: Proposed as of 2026-09-13. Sections 3 and 4 describe the existing v1
single-method format; this section is a future extension, not implemented storage.
See [image generation](./image-generation.md) for mode and routing policy.

Implemented bridge (2026-09-13): custom public image APIs resolve an exclusive
`api_key_env`, otherwise a stored v1 API key, otherwise the standard provider
environment key. They never send OAuth or mutate auth.json. Thus an environment
image key coexists with stored chat OAuth today, but the v2 storage/migration and
image-key entry UI described below remain unimplemented. Builtin follows current
OpenAI chat auth: OAuth uses the dedicated Codex image backend and existing
AuthResolver token refresh/account routing without a key; API-key chat uses the
public Image API. OAuth is never redirected to a public billed endpoint.

### 9.1 Separate stored credentials from selected chat authentication

A provider may hold both an API key and OAuth tokens. Preserve an explicit chat
method selection independently of the available credentials. Adding an image API
key must not switch chat away from OAuth or replace its tokens.

Proposed v2 shape (placeholder secrets only):

```json
{
  "version": 2,
  "providers": {
    "openai": {
      "chat_method": "oauth",
      "credentials": {
        "api_key": { "api_key": "<api-key>" },
        "oauth": {
          "access_token": "<access-token>",
          "refresh_token": "<refresh-token>",
          "expires_at": 0
        }
      }
    }
  }
}
```

`chat_method` is `api_key | oauth`. It may be absent for an image-only provider
entry; do not implicitly select that provider for chat just because it has an image
credential. An explicit chat selection still follows normal onboarding. OAuth
fields retain their existing meanings, including optional `account_id`.

Auth resolution must take the purpose/required method into account:

- Chat uses its selected method. Existing v1 selection is preserved on migration.
- Builtin images reuse the resolved chat auth context, including any normal token
  refresh, without selecting another credential. This covers verified hosted,
  native-output, or independent image endpoints defined by that connection's
  trusted adapter, not arbitrary public endpoints with the same provider name.
  No automatic API-key fallback or assumption of subscription entitlement.
- Custom images require an API key and never receive OAuth tokens. Precedence is
  explicit image `api_key_env` (exclusive), stored provider API key, then standard
  provider environment variable. A missing explicit reference is an error.
- Environment lookups do not persist secrets or mutate chat selection. An explicit
  settings action may save a key to auth storage without altering other methods.
- Missing/invalid credentials never silently switch method, account, or endpoint.
- Credential removal is method-specific unless the user explicitly removes the
  entire provider. Removing selected chat credentials requires reauthentication or
  explicit reselection, not automatic use of the remaining method.

### 9.2 Migration and write safety

- Read v1 and normalize in memory: copy each credential into its method slot and
  copy `method` into `chat_method`. Preserve tokens, expiry, account ID, and all
  provider entries, including those not currently selected.
- Do not rewrite the file on read. Persist v2 only on an explicit credential or
  selection mutation, after validating the complete candidate document. Background
  refresh keeps v1 on disk until that explicit migration; after migration it updates
  the v2 OAuth slot.
- Malformed/unknown versions must report an error without overwriting the source.
- Serialize credential read-modify-write operations and persist atomically with
  restrictive permissions. Coordinate separate runtime processes, not only one
  in-process queue, so refresh, API-key addition, and logout cannot lose updates.
- Refresh updates only its OAuth slot and must not resurrect credentials removed
  concurrently. Retain the API key and chat selection during refresh.
- Existing v1-only clients cannot read v2. Before migration, document this
  compatibility boundary and provide a deliberate rollback/export procedure.
  Do not silently downgrade or discard one credential. Any rollback copy contains
  secrets and requires the same protection as the active auth file.

Keep migration, resolution, concurrent mutation, and unchanged chat behavior under
automated tests before enabling either image mode. General named accounts and
arbitrary endpoint credential profiles are deferred beyond this extension.

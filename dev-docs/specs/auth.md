# Auth / Credential Spec

Status: `Mixed` — v1 file-backed `auth.json` / `mcp-auth.json`, OAuth/device-code flows, and `auth.*` management RPCs are implemented; v2 credential coexistence, macOS Keychain storage, interprocess locking, sandbox read protection, and automatic migration are agreed target behavior (2026-11-22).

This document defines how codelia stores and uses provider and MCP credentials.

## 0. Implementation status (as of 2026-11-22)

Implemented:
- Runtime provider auth resolution for builtin providers (`openai`, `anthropic`, `openrouter`, `google`, `deepseek`, `moonshot`, `zai`, `xai`) and configured `providers.<name>` Responses endpoints
- Local v1 `auth.json` and `mcp-auth.json` read/write (`0600` where possible)
- OpenAI OAuth via loopback callback (`http://localhost:<port>/auth/callback`)
- OpenAI device-code login for SSH/headless environments
- SSH-aware manual browser fallback for loopback OAuth (`CODELIA_OAUTH_BROWSER=manual`, auto-enabled when SSH env is detected, supports pasted callback URL/code)
- UI-driven auth prompts (`ui.pick.request` / `ui.prompt.request` / `ui.confirm.request`)
- Management RPCs (`auth.status`, `auth.login`, `auth.login.complete`, `auth.login.cancel`, `auth.login.status`, and scoped/all `auth.logout`)

Planned (agreed target spec in section 9):
- Storage backend abstraction, mode selection (`auto` / `keyring` / `file`), and write-ahead backend state marker (`storage-state.json`) to prevent split-brain fallback and distinguish interrupted migrations
- macOS Keychain direct JSON storage via a minimal native `Security.framework` helper for `auth` and `mcp-auth`, with `0600` (POSIX) / owner-only DACL (Windows) file fallback on unmigrated Linux, Windows, and headless/SSH environments
- Dedicated `0700` `<configDir>/credentials/` directory in default sandbox `protectedPaths` for file-backed credentials, temp files, lock, and state marker, plus explicit boundary and inline-secret warning for readable `config.json`
- Auth schema v2 (per-provider OAuth + API-key coexistence), MCP auth schema v2 (endpoint/issuer/client binding), explicit stored-vs-env precedence, and non-persistence of env-var API keys
- Interprocess SQLite locking (35s wait) + bounded OAuth refresh timeout (30s), atomic file writes, locked `McpAuthStore.update()` with 401-triggered refresh preservation, universal all-direction pre-write conflict detection + two-phase migration, and `auth.status` storage/warning metadata

Planned (other):
- Follow-up secret references (`secret_ref`) to move inline MCP secrets (`oauth.client_secret`, static auth `headers`, stdio `env`) out of readable `config.json` into the protected credential store
- Startup-triggered first-run onboarding for no-auth users (TUI)
- Friendly onboarding copy for first-run auth and model selection steps
- Production OAuth callback flow with external callback + DB-managed `oauth_state`
- Native OS credential store backends for Linux (Secret Service) and Windows (Credential Manager / DPAPI)

## 1. Goals

- Support per-provider credentials (API key or OAuth) without relying on env vars.
- Store credentials with minimal plaintext exposure and clear confinement boundaries.
- Allow TUI to prompt for missing credentials (CLI later).
- Keep provider-specific auth logic isolated.

## 2. Storage location

Current (implemented v1), using storage paths defined in `dev-docs/specs/storage-layout.md`:

- Default: `~/.codelia/auth.json` and `~/.codelia/mcp-auth.json`
- XDG layout (opt-in): `$XDG_CONFIG_HOME/codelia/auth.json` and `$XDG_CONFIG_HOME/codelia/mcp-auth.json`

Target (planned in section 9):

- macOS Keychain (`codelia.auth`, `codelia.mcp-auth`) when active, or
- Dedicated `0700` directory `<configDir>/credentials/` (`~/.codelia/credentials/auth.json`, `~/.codelia/credentials/mcp-auth.json`, plus `.auth-store-lock.sqlite` and non-secret `storage-state.json`).

Security expectations:

- Create credential directories with `0700` and files with `0600` when possible.
- Never print secrets in logs or UI events.
- Protect file-backed credentials from confined agent shells and built-in file tools (section 9.3).

## 3. auth.json format (v1, implemented)

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

Notes (current implemented v1 behavior):

- `expires_at` is epoch milliseconds.
- `account_id` is optional (used for OpenAI subscription headers).
- **Precedence and current env persistence caveat**: stored credentials in `auth.json` take precedence over environment variables. Currently, `AuthResolver.resolveProviderAuth()` persists an env-sourced API key into `auth.json` via `setProviderAuth()`, and if the environment variable remains set after `/logout`, the next use re-saves it to `auth.json`. Keeping env-sourced keys strictly in memory without disk persistence is planned in section 9.4.

## 4. Provider support matrix (implemented)

- OpenAI
  - `method: oauth` (ChatGPT Plus/Pro subscription; loopback, manual paste, or device code)
  - `method: api_key` (standard OpenAI API key)
- Anthropic, OpenRouter, Google, DeepSeek, Moonshot, Z.ai, xAI
  - `method: api_key` only
- Configured `providers.<name>` Responses endpoints
  - `method: api_key` only (or endpoint `api_key_env`)

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

- Stored auth has no provider credentials for supported providers.
- No supported provider API key env vars are available (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY` / `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `XAI_API_KEY`, or configured `providers.<name>.api_key_env`).

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
- Linux Secret Service (`org.freedesktop.secrets`) and Windows Credential Manager / DPAPI backends behind the section 9.1 `CredentialStorageBackend` abstraction.
- Multi-account / named credential profiles per provider.

## 9. Credential storage v2, OS keyring, and migration (Planned — agreed 2026-11-22)

Status: Agreed target specification as of 2026-11-22 (not yet implemented). Sections 3 and 4 describe the currently implemented v1 file-backed format. See [image generation](./image-generation.md) for image mode/routing policy and [command approval](./command-approval-and-auto-review.md) for sandbox protection.

Implemented bridge (2026-09-13): custom public image APIs resolve an exclusive `api_key_env`, otherwise a stored v1 API key, otherwise the standard provider environment key. They never send OAuth or mutate `auth.json`. Builtin follows current OpenAI chat auth: OAuth uses the dedicated Codex image backend and existing `AuthResolver` token refresh/account routing without a key; API-key chat uses the public Image API.

### 9.1 Storage backends, mode selection, and write-ahead split-brain prevention

Introduce a platform-agnostic `CredentialStorageBackend` abstraction shared by both provider auth (`auth`) and MCP OAuth (`mcp-auth`).

Configuration (global-only; project-level `.codelia/config.json` must ignore `auth.storage`):

- Config key: `auth.storage` in global `config.json`
- Env override: `CODELIA_AUTH_STORAGE`
- Allowed values:
  - `auto` (default): select the backend based on where credentials live and platform capability (see write-ahead split-brain rule below).
  - `keyring`: require the OS credential store. Fail closed with a clear error when unavailable or locked; never fall back to plaintext files.
  - `file`: always use local files inside `<configDir>/credentials/` (`0600` on POSIX; owner-only DACL verified on Windows — see section 9.3).

Write-ahead backend state machine (`storage-state.json`):

- Persist a non-secret state file `<configDir>/credentials/storage-state.json` (never contains secret values) to distinguish steady ownership from an interrupted migration:
  ```json
  {
    "version": 1,
    "status": "steady",
    "active_backend": "keyring"
  }
  ```
  During migration (written **before** modifying the destination backend):
  ```json
  {
    "version": 1,
    "status": "migrating",
    "active_backend": "file",
    "target_backend": "keyring",
    "stores": {
      "auth": "pending",
      "mcp_auth": "pending"
    }
  }
  ```
- Under `auto`:
  - If `storage-state.json` records `active_backend: "keyring"` **or** (`status: "migrating"` and `target_backend: "keyring"`), Codelia **must not** silently fall back to an empty file when macOS Keychain is locked (e.g., over an SSH session). Instead, fail auth operations with an actionable error instructing the user to unlock Keychain (`security unlock-keychain ~/Library/Keychains/login.keychain-db`) or explicitly switch to `file` mode once unlocked.
  - Fallback from `auto` to `file` is allowed only when no `keyring` ownership or `keyring`-targeted migration is recorded (e.g., Linux, Windows, or an unmigrated headless macOS environment).

First-phase native backend is macOS Keychain (Claude Code style), while `CredentialStorageBackend` keeps Linux Secret Service and Windows Credential Manager / DPAPI pluggable later without changing callers or schema.

### 9.2 macOS Keychain layout, threat model, and native helper contract

**Threat model (what Keychain does and does not protect):**

- Keychain access control depends on the creating binary's code-signing / ACL policy. Any **unconfined** process running as the same macOS user that is allowed by the Keychain item's ACL (for example, invoking the helper or, if using `/usr/bin/security`, invoking `security` from a `full-access` shell) can still read the item without a confirmation dialog.
- Confined shells (`readonly` / `workspace-write`) cannot access Keychain because Seatbelt `(deny default)` blocks SecurityServer Mach connections; this provides the same confined-agent boundary as `protectedPaths` on files.
- Keychain's primary security benefit is **keeping plaintext credentials off disk** (protecting against backups, dotfiles sync, search indexers, accidental directory copies, and third-party tools scanning `~/.codelia`).

**Primary implementation mechanism (minimal macOS native helper using `Security.framework`):**

- Do **not** rely on `/usr/bin/security -i` as the primary write path: Apple's open-source `security` tool limits interactive stdin lines to **4,096 bytes** (`SecurityTool/macOS/security.c`, `readline.c`), which overflows on multi-provider or multi-MCP JSON payloads (especially if hex-encoded).
- Use a minimal macOS native helper binary (Rust using `Security.framework`, shipped alongside Codelia's existing macOS platform package alongside `crates/mxc-launcher`) that exchanges UTF-8 JSON requests/responses strictly over private stdin/stdout pipes:
  - Never passes secret values in CLI argv or environment variables.
  - Supports arbitrary payload sizes (≥ 32 KiB+) with no 4 KiB line limit and no hex/newline decoding ambiguity.
  - Classifies Keychain outcomes explicitly (`not_found`, `locked` / `errSecInteractionNotAllowed`, `unavailable`, `error`).
- **Pre-implementation prototype gate**: before writing the runtime adapter, prototype the native helper on macOS to verify (1) round-trip read/update/delete for 1 KiB–32 KiB+ UTF-8 JSON payloads, (2) locked Keychain detection, and (3) real macOS Keychain ACL / confirmation-dialog behavior for development (unsigned/ad-hoc) vs packaged binaries.

**Entry layout and approval-time reads:**

- Separate generic-password entries for provider auth and MCP auth:
  - Service names: `codelia.auth` and `codelia.mcp-auth`.
  - Account name: `codelia-<sha256(canonical(configDir)).slice(0, 16)>`, so isolated `CODELIA_LAYOUT=xdg`, custom config paths, and tests never collide with the user's default Keychain entries.
- **Approval-time synchronous reads (`loadForApproval()`)**:
  - `local-reviewer.ts` (`readSettings`) invokes `AuthStore.loadForApproval()` synchronously. The initial Keychain implementation invokes the native helper synchronously (`execFileSync`) with a short timeout (2 seconds) and fail-closed error handling (timeout/error behaves as auth unavailable, never hanging or falling back to plaintext). Refactoring `readSettings` to async is deferred unless measured latency justifies it.

### 9.3 Sandbox read protection, Windows ACLs, and `config.json` secret boundary

Move file-backed credentials, atomic-write temporary files, the interprocess SQLite lock, and `storage-state.json` into a dedicated `0700` directory:

- Default: `~/.codelia/credentials/` (`auth.json`, `mcp-auth.json`, `.auth-store-lock.sqlite`, `storage-state.json`, and sibling `*.tmp` files during atomic writes)
- XDG layout: `$XDG_CONFIG_HOME/codelia/credentials/`

**OS permission & Windows ACL requirements:**

- On POSIX, create `<configDir>/credentials/` with mode `0700` and credential files with `0600`.
- On Windows, Node's `0o600` / `0o700` modes do **not** restrict NTFS read ACLs. Before writing any file-backed credentials on Windows, verify directory ownership and establish/verify an owner-only DACL (inheritance disabled; only the current user and `SYSTEM` granted access; no `Users`, `Authenticated Users`, or `Everyone` read ACEs). If a safe owner-only DACL cannot be established and verified, fail closed and refuse to write plaintext credentials.

**Sandbox enforcement:**

- Eagerly create `<configDir>/credentials/` during storage initialization (`ensureStorageDirs`) so the directory always exists before any confined shell starts.
- Add `<configDir>/credentials` to default `protectedPaths` (and `protectedAliasPaths`) in `workspacePathProtection` and built-in file tools (`SandboxContext` / `runtimeResourcePolicy`).
  - Because the directory always exists, both macOS Seatbelt and Linux `linux-shell-backend.ts` mask the entire directory reliably — covering temporary files created during atomic writes and surviving hourly OAuth refresh `rename()` calls without `missing_protected_mountpoint` or mount-detachment failures.
- While legacy root-level `~/.codelia/auth.json` or `~/.codelia/mcp-auth.json` still exists (prior to migration), also include those legacy paths in `protectedPaths` (unconditionally on macOS; when present on Linux) until migration removes them.
- Under confined sandbox modes (`readonly` / `workspace-write`), OS isolation denies both reads and writes to `credentials/` and legacy auth files, and per-command approval cannot open them. Built-in file tools (`read`, `edit`, `write`, `apply_patch`) deny access across all sandbox modes, including `full-access`. Under `full-access`, shell commands run as the login OS user (unchanged).

**Protection boundary for readable `config.json` (inline MCP secrets):**

- `config.json` remains in `readOnlyPaths` so agents can inspect non-secret configuration.
- Consequently, any secrets written inline in `config.json` — specifically MCP `oauth.client_secret`, static auth `headers` (e.g., `Authorization`, `*-Key`, `*-Token`), and stdio MCP `env` values — **remain readable** by confined shells and built-in file tools even after `auth` and `mcp-auth` move to `credentials/` or Keychain.
- **Phase 1 (this track)**: detect inline secret-like MCP fields in `config.json` and surface non-secret warnings (via `auth.status` / diagnostics) explaining that inline config secrets are outside `credentials/` protection.
- **Phase 2 (follow-up)**: introduce opaque credential-store references (e.g., `secret_ref`) for MCP `oauth.client_secret`, static auth headers, and stdio `env` values, plus a migration flow that moves inline values into the protected credential store and replaces them with non-secret references in `config.json`.

### 9.4 Provider auth v2 (coexistence) and MCP auth v2 (endpoint/issuer binding)

#### Provider auth v2

A provider may hold both an API key and OAuth tokens. Preserve an explicit chat method selection independently of the available credentials. Adding an image API key must not switch chat away from OAuth or replace its tokens.

Target v2 shape for provider auth (placeholder secrets only):

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

- `chat_method` is `api_key | oauth`. It may be absent for an image-only provider entry; do not implicitly select that provider for chat just because it has an image credential. An explicit chat selection still follows normal onboarding. OAuth fields retain their existing meanings, including optional `account_id`. Optional `api_base` stays on `credentials.api_key` when applicable.

Auth resolution takes purpose/required method into account:

- **Stored vs environment precedence**: stored credentials take precedence over environment variables for chat auth. Environment lookups are in-memory fallback only and **must never persist secrets into stored auth** (removing the v1 `AuthResolver.resolveProviderAuth()` persistence behavior). Note that keys auto-persisted by older v1 versions remain stored until removed via `/logout <provider>`.
- Chat uses its selected `chat_method`. Existing v1 selection is preserved on migration.
- Builtin images reuse the resolved chat auth context, including normal token refresh, without selecting another credential. No automatic API-key fallback or assumption of subscription entitlement.
- Custom images require an API key and never receive OAuth tokens. Precedence is explicit image `api_key_env` (exclusive), stored provider `credentials.api_key`, then standard provider environment variable. A missing explicit reference is an error.
- Missing/invalid credentials never silently switch method, account, or endpoint.
- Credential removal is method-specific when requested, or removes the entire provider entry for `/logout <provider>`. Removing the selected chat credential requires reauthentication or explicit reselection, not automatic fallback to the other stored method.

#### MCP auth v2 (endpoint, issuer, and client binding)

Current `McpManager` selects stored tokens by `serverId` alone, while project-level `.codelia/config.json` can override the `url` / `oauth` endpoint for the same `serverId`. To prevent an untrusted or modified project config from redirecting a saved Bearer token to a different server, bump `mcp-auth` to `version: 2` and bind every stored token to its canonical connection and authorization identity:

```json
{
  "version": 2,
  "servers": {
    "example": {
      "binding": {
        "resource_uri": "https://mcp.example.com/mcp",
        "issuer": "https://auth.example.com",
        "token_endpoint": "https://auth.example.com/oauth/token",
        "client_id": "<client-id>"
      },
      "tokens": {
        "access_token": "<access-token>",
        "refresh_token": "<refresh-token>",
        "expires_at": 0,
        "token_type": "Bearer",
        "scope": "..."
      }
    }
  }
}
```

- **Send/refresh binding check**: before attaching a stored access token to an MCP HTTP request or sending a stored refresh token to a token endpoint, verify that the resolved server's canonical `resource_uri` (scheme/host/port/path), `issuer`, `token_endpoint` (when known), and `client_id` match the stored `binding`. On any mismatch, **never send or refresh the stored token**; treat the server as unauthenticated for that endpoint and require fresh authorization.
- **Legacy v1 `mcp-auth.json` migration**: v1 entries lack `resource_uri` / `issuer` bindings. Any legacy entry whose canonical destination and issuer cannot be unambiguously verified from trusted configuration must **not** be migrated as a reusable token; drop/quarantine unbound entries on migration and surface a re-authentication notice so existing tokens can never be replayed to an unverified endpoint.

### 9.5 Interprocess locking, refresh timeout, atomic writes, and MCP `update()` / 401 refresh

- Coordinate credential read-modify-write sequences across separate runtime processes (TUI, `/lane`, subagents, Desktop) using an owner-verified SQLite `BEGIN IMMEDIATE` lock at `<configDir>/credentials/.auth-store-lock.sqlite` (same locking primitive as `ProjectsPolicyStore`, but with an auth-specific wait budget — do **not** copy `projects-store.ts`'s 1-second deadline).
- Apply the interprocess lock to **both** Keychain and file backends so concurrent OAuth token refreshes, logins, and logouts cannot race or lose updates.
- **Bounded refresh timeout and lock wait budget**:
  - Give OAuth token refresh HTTP requests (both OpenAI `refreshAccessToken()` and MCP OAuth refresh) a fixed internal timeout of **30 seconds** independent of caller `AbortSignal`, so a hung network request cannot stall all sibling processes while still allowing a started rotation to complete if the caller cancels.
  - Set the auth interprocess lock acquisition wait budget to **35 seconds** (> refresh timeout) so sibling processes wait for an in-flight rotation and observe the newly saved token instead of double-consuming a single-use refresh token.
- **Atomic file writes**: write to a sibling `0600` temporary file inside `<configDir>/credentials/`, call `fsync`, and atomically `rename()` into place. Never overwrite the live file in place.
- **Provider refresh safety**: refresh updates only the `credentials.oauth` slot, preserves `credentials.api_key` and `chat_method`, and must not resurrect a credential that was concurrently removed.
- **MCP `McpAuthStore` / `McpManager` / CLI concurrency and 401 refresh**:
  - Replace whole-file `save(this.authFile)` calls (`McpManager.persistTokens`, CLI `writeMcpAuth`) with locked `McpAuthStore.update(mutate)` (reload inside lock → mutate only the target server entry → persist).
  - Preserve **401-triggered refresh** (`packages/runtime/src/mcp/http-client.ts`): pass the rejected `failedAccessToken` into the locked MCP refresh routine. Inside the lock, reload the latest stored entry and verify its `binding`:
    - If the stored `access_token` already differs from `failedAccessToken`, another process already rotated it — return the newer token immediately without calling the token endpoint again.
    - If the stored `access_token` still equals `failedAccessToken` (even if `expires_at` has not passed or is absent), perform **one** bounded (30s) refresh and persist via locked `update()`.

### 9.6 Universal two-phase migration, conflict detection, and reverse migration

Apply **one uniform pre-write conflict & two-phase protocol** to **every** migration direction (`legacy root → credentials/`, `legacy/credentials → keyring`, and `keyring → credentials/`):

1. Acquire the interprocess lock.
2. Read and normalize **both** source and destination for **both** `auth` and `mcp-auth` **before any write** (malformed or unknown versions fail closed without overwriting either side).
3. **Pre-write conflict check (all directions)**:
   - If the destination is empty for a store → schedule migration for that store.
   - If **both** source and destination hold non-empty credentials and their normalized v2 contents are structurally **identical** (e.g., crash after verified write before cleanup) → treat as crash recovery: skip overwriting destination, verify/commit steady state, and clean up the redundant source.
   - If **both** source and destination hold non-empty credentials that **differ** → **fail closed** immediately without writing or deleting either side. Scope of failure: block auth-backed operations (run start, login, refresh) for the affected store while keeping non-auth commands (`/help`, `auth.status`, and explicit conflict resolution / logout) usable; surface an explicit resolution path so the user chooses which store to keep (or exports/clears the other).
4. **Write-ahead transition marker**: atomically write `<configDir>/credentials/storage-state.json` with `status: "migrating"`, `active_backend: <old>`, `target_backend: <new>`, and `stores: { auth: "pending", mcp_auth: "pending" }` **before** modifying the destination backend.
5. **Write and verify both stores**:
   - Write normalized `auth` to the destination, read back and verify deep structural equality, then mark `stores.auth = "verified"`.
   - Write normalized `mcp-auth` (dropping any unbound legacy v1 entries with a recorded re-auth notice) to the destination, read back and verify deep structural equality, then mark `stores.mcp_auth = "verified"`.
   - If writing or verification fails for either store, leave the source untouched and report the failure.
6. **Commit steady state**: only after **both** stores are verified on the destination backend, atomically update `storage-state.json` to `{ version: 1, status: "steady", active_backend: <new> }`.
7. **Source cleanup**:
   - Forward migration (`legacy → credentials/` or `file → keyring`): unlink legacy/source plaintext files only after step 6 commits.
   - Reverse migration / rollback (`keyring → file`, triggered when switching `auth.storage` to `file` or via explicit export/rollback): write `0600` (POSIX) / owner-only DACL (Windows) files into protected `<configDir>/credentials/`, commit step 6, and remove Keychain entries on explicit backend switch so switching back later does not false-conflict. Any rollback/export file inherits the same `<configDir>/credentials/` protection.

**Crash resume rule**: if startup observes `status: "migrating"`, re-enter step 1 under the lock targeting `target_backend`. If `target_backend === "keyring"` and Keychain is locked (e.g., SSH), fail closed with unlock instructions rather than falling back to `file`.

**Compatibility boundary**: existing v1-only Codelia clients cannot read Keychain entries, `<configDir>/credentials/` paths, or v2 schemas. Document this boundary in release notes/docs; do not silently downgrade or discard one credential method.

### 9.7 Status visibility (`auth.status`)

Extend `AuthStatusResult` (in `@codelia/protocol`) with non-secret storage and warning metadata so TUI and Desktop clients can show where credentials are stored and surface actionable issues:

- `storage`:
  - `configured`: `"auto" | "keyring" | "file"`
  - `active`: `"keyring" | "file"`
  - `state`: `"steady" | "migrating" | "conflict"`
  - `fallback_reason?`: bounded reason code when `configured === "auto"` falls back to `"file"` (e.g., `"unsupported_platform"`, `"keychain_locked"`, `"keychain_unavailable"`).
- `warnings?`: bounded non-secret warning codes (e.g., `inline_mcp_config_secrets` when `config.json` contains inline MCP secrets outside `credentials/`, `mcp_reauth_required` for dropped unbound legacy MCP entries, or `storage_conflict` for dual-store mismatch).
- Never include raw key material, token bytes, inline config secret values, or Keychain payloads in RPC results, diagnostics, or logs.

Keep all-direction migration, write-ahead crash recovery, conflict handling, reverse migration, MCP endpoint binding, MCP 401 locked refresh, concurrent provider/MCP refresh and logout, env non-persistence, Windows ACL checks, sandbox `credentials/` read-denial, and unchanged chat behavior under automated tests before shipping. General named accounts and arbitrary endpoint credential profiles remain deferred.

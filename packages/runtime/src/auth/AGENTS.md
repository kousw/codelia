# Runtime authentication

- OpenAI OAuth token endpoint failures are typed `ProviderFailureError` values.
  Preserve the operation, HTTP status and only allowlisted OAuth reason codes;
  never retain the raw error response, tokens or request headers as diagnostics.
- OAuth HTTP 400/401/403 requires sign-in; 429/5xx remains a transient endpoint
  failure. Do not silently clear credentials, launch login or switch auth/model.
- `AuthResolver.getOpenAiAccessToken()` reloads expired cached credentials inside
  `AuthStore.updateV2()`, holding the interprocess SQLite lock (`<configDir>/credentials/.auth-store-lock.sqlite`,
  35s wait budget) through refresh and atomic save. `refreshAccessToken()` enforces
  a fixed 30s internal timeout independent of caller cancellation so a hung endpoint
  cannot stall sibling processes while an already-started rotation still completes.
- `AuthStore` stores strict v2 (`version: 2`, per-provider `chat_method` plus
  coexisting `credentials.api_key` and `credentials.oauth` slots) in either macOS
  Keychain (`codelia.auth` via `/usr/bin/security`) or protected
  `<configDir>/credentials/auth.json` (`0600` on POSIX, verified owner-only DACL on
  Windows), controlled by global-only `auth.storage` (`auto` | `keyring` | `file`)
  or `CODELIA_AUTH_STORAGE`.
- Refresh updates only `credentials.oauth` via `updateProviderOAuthTokens()`,
  preserving `credentials.api_key` and `chat_method` and never resurrecting a
  concurrently removed entry. Environment-variable API keys are strictly in-memory
  fallbacks and are never persisted into stored auth.
- `AuthStore.loadForApprovalV2()` performs synchronous approval-time reads (using
  `execFileSync` with a shared 2s deadline for the whole Keychain read) and fails closed on
  locked/unavailable/timeout errors.
- Check request cancellation before sending a refresh and after saving the
  replacement. Once refresh starts, the issuer may consume the old token.
  Keep that exchange and save independent of request cancellation, and return
  no token to a cancelled caller. Continue checking the expected account.
- Token-callback failures pass through the real OpenAI SDK, which wraps them in
  `cause`. The Core classifier preserves trusted, same-provider typed failures
  from bounded cause chains. Test this boundary, not just prebuilt UI payloads.
- Focused regression coverage: `tests/openai-oauth.test.ts`,
  `tests/auth-refresh.test.ts`, `tests/auth-env.test.ts`, `tests/auth-logout.test.ts`,
  `tests/auth-v2-coexistence.test.ts`, `tests/auth-keychain-status.test.ts`, and
  `tests/run-diagnostics.test.ts`.

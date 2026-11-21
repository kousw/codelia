# Runtime authentication

- OpenAI OAuth token endpoint failures are typed `ProviderFailureError` values.
  Preserve the operation, HTTP status and only allowlisted OAuth reason codes;
  never retain the raw error response, tokens or request headers as diagnostics.
- OAuth HTTP 400/401/403 requires sign-in; 429/5xx remains a transient endpoint
  failure. Do not silently clear credentials, launch login or switch auth/model.
- `AuthResolver.getOpenAiAccessToken()` reloads expired cached credentials inside
  `AuthStore.update()` and holds its per-file queue through refresh and save.
  This prevents duplicate refreshes across resolvers in one runtime process and
  uses a newer credential already saved by another client. The queue is not an
  interprocess lock; simultaneous refreshes in separate processes remain possible.
- Check request cancellation before sending a refresh and after saving the
  replacement. Once refresh starts, the issuer may consume the old token.
  Keep that exchange and save independent of request cancellation, and return
  no token to a cancelled caller. Continue checking the expected account.
- Token-callback failures pass through the real OpenAI SDK, which wraps them in
  `cause`. The Core classifier preserves trusted, same-provider typed failures
  from bounded cause chains. Test this boundary, not just prebuilt UI payloads.
- Focused regression coverage: `tests/openai-oauth.test.ts`,
  `tests/auth-refresh.test.ts` and `tests/run-diagnostics.test.ts`.

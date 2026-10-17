# Runtime RPC handlers

`auth.ts` handles confirmed local logout and host-owned credential removal.
Named logout deletes only the requested saved provider and resets only a matching
current session. Host adapters must opt into `clearProviderAuth`; scoped requests
must never call all-provider `clearAuth` as a fallback. Keep the advertised
`supports_scoped_logout` capability aligned with this support.

`run-metrics.ts` derives observed TPS from optional persisted completion timing
and provider usage. `run.ts` emits normal-mode `run.metrics` for every completed
LLM call and null at each call start to clear the previous call's value. Reject
sub-250ms intervals and known hidden-reasoning usage without a matching observed
reasoning interval. Diagnostics reuse the
same calculation. Metrics failures are best-effort and must not fail the run.

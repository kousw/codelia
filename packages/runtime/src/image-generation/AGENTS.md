# Runtime image generation

Implemented public API, Google custom and Codex OAuth routes:
`dev-docs/specs/image-generation.md` sections 1.1-1.5.

- `route.ts`: discriminated API-key/Codex OAuth route, no auth-method fallback.
- `codex.ts`: fixed-origin JSON generation/edit, fresh AuthResolver token callback,
  account pinning and redacted refresh errors; never reads an image API key.
- `catalog.ts`: unpaid OpenRouter image/endpoint discovery, bounded memory cache.
- `http.ts`: bounded/redacted JSON transport, cancellation, no redirects/retries.
- `adapter.ts`: OpenAI, pinned OpenRouter or Google request; edits send originals.
- `google.ts`: official SDK Interactions, `store=false`, bounded response,
  PNG/JPEG returned originals and all final model-output images. Explicit
  JPEG requests are sent exactly and mismatches fail; explicit PNG is rejected
  locally after a live HTTP 400. No automatic retry.
- `references.ts`: ordered URL/file/artifact input, MIME/header validation through
  `image-size`, max 32 MiB each/128 MiB total and 12288px/20 MP. No re-encoding.
- `source-reader.ts`: local capability only; bounded realpath-confined regular-file
  reads and unauthenticated HTTP(S) downloads with direct socket-level public DNS validation,
  no redirects, 15s timeout, and no provider credentials. URLs are materialized in
  memory for current routes; provider-side arbitrary URL retrieval is not verified.
  Preserve original Host/TLS servername with custom DNS lookup on Bun.
- `source-proxy.ts`: per-request HTTP(S) agents honor trusted host `HTTP_PROXY`,
  `HTTPS_PROXY`, `ALL_PROXY` and lowercase equivalents (lowercase wins), plus
  `NO_PROXY`/`no_proxy`. Scheme-specific proxies take precedence over ALL_PROXY.
  Proxied DNS/destination access belongs to the proxy; NO_PROXY connections retain
  validated direct lookup. No global mutation, direct fallback or credential-bearing
  errors. Requires Bun 1.4.4+, Node 22.21.x or Node 24.5+ when proxies are configured.
- `images` is the preferred tool input; `reference_artifact_ids` remains an exclusive
  compatibility alternative. Common/persistence limit 16; Codex limit 5; Google 14; OpenRouter
  endpoint count/options are checked once before reference acquisition. Do not trim
  or reorder references. Files/URLs are read once per explicit generation, never
  during chat-history replay. Attached images also enter history as immutable refs.
- `attachments.ts`: imports submitted inline PNG/JPEG/WebP/GIF at run admission,
  preserves original MIME/detail, and labels IDs for explicit generation references.
  `agent-factory` supplies `RuntimeState.prepareRunImages` using the same store as
  `resolveImage` and image tools, including generation-off mode. No remote URL
  fetch, implicit reference selection, or generation happens during admission/replay.
  Persisted run.start records and history contain refs, not imported base64.
  Existing sessions with legacy inline parts are not rewritten automatically.
- `tools.ts`: generate/inspect/export; inner permission gates cover direct RPC.
- `local-store.ts`: workspace-scoped artifact store composition for local runtimes.
- `export.ts`: new-file-only workspace export; runtime paths remain remote on SSH.
- `../rpc/image.ts`: idle-only settings picker/save and bounded artifact transfer.

Tests: `bun test packages/runtime/tests/image-generation.test.ts packages/runtime/tests/image-rpc.test.ts packages/runtime/tests/image-codex.test.ts`.
Source/history tests: `bun test packages/runtime/tests/image-sources.test.ts packages/runtime/tests/image-source-reader.test.ts packages/core/tests/image-references.test.ts`.
Source transport tests bundle `image-source-transport.fixture.ts` for isolated Bun
and Node children with local origin/proxy peers. Only those children change proxy
variables. They cover direct bytes/cancellation, proxy routing/auth, NO_PROXY DNS
validation, HTTPS TLS/hostname checks, stalled CONNECT cancellation, bounds and no
direct fallback. Older Node children verify direct transport plus explicit proxy
refusal. Actual Cloud proxy/TLS integration remains a separate environment check.
The history test compares previous LLM input prefixes/tools across three image turns
and disk reload. This verifies stable inputs, not server KV-cache residency/hit counts.
The live test additionally requires `INTEGRATION=1 CODELIA_IMAGE_LIVE=1`, an explicit
`CODELIA_IMAGE_MODEL`, and provider/endpoint selection. Public routes use environment
API keys; `CODELIA_IMAGE_PROVIDER=codex` uses existing stored OAuth and refresh.
It consumes one image request; obtain explicit permission before each live run.
The normalized executeRaw result is `{type:"parts",parts}`, not an array.
OAuth generation/save/reload/model-input passed live on 2026-09-13 requesting
`gpt-image-2`; effective model is unknown. Edits are mock-transport verified only.
Stored OAuth+API-key v2 migration, hosted/native image output,
custom-host adapters and automatic artifact GC remain unimplemented.

- New generate/inspect results call `store.modelReference` once before entering
  history; `image_inspect original=true` uses original pixels. Replay only resolves
  the stored descriptor. Generation references/export/RPC preview use `store.read`
  originals. View failure after successful generation reports the saved original
  and a warning; it must not masquerade as another generation failure.

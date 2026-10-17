# Image Generation Spec

Status: Partial implementation (public Image API and Codex OAuth routes, 2026-09-13).

## 1. Intent and implementation status

Provide image generation through `off | builtin | custom`, with explicit routing,
reusable credentials, image ContentParts, durable originals, and text-only TUI
access. Sections 1.1-1.3 define the implemented subset. Later sections retain the
broader target design; they do not imply support for every provider/execution kind.

Decisions:

- `builtin` uses image capabilities attached to the current conversation connection;
  it is not restricted to provider-hosted tools and does not imply free usage.
- `custom` uses a Codelia tool and a separately selected image provider/model.
- Both modes allow validated provider-specific image options.
- Store immutable originals once, persist references in history, and materialize
  actual image ContentParts for model input. Never substitute a path for vision.
- Automatically return newly generated tool images to an image-capable model;
  use stable artifact IDs and originals when revisiting or editing an image.
- TUI displays metadata and access actions, independently of model image input.

Schema details outside sections 1.1-1.3 remain target contracts. External API capability
is not Codelia implementation status; see the dated
[provider matrix and Codex research](./providers/image-generation.md).

| Claim | Status | Local evidence / gate |
| --- | --- | --- |
| One stored auth method per provider | Implemented | `packages/runtime/src/auth/store.ts`: `ProviderAuth`, `AuthFile` v1 |
| Stored auth precedes environment fallback | Implemented | `packages/runtime/src/auth/resolver.ts`: `resolveProviderAuth` |
| Local image inspection using image ContentParts | Implemented | `packages/runtime/src/tools/view-image.ts`; `packages/core/src/types/llm/content.ts` |
| Production image preview | Implemented | [TUI preview contract](tui-image-preview.md); `/image`, composer attachments and explicit `/image-artifact` RPC transfer |
| Standalone multi-protocol preview lab | Experimental | `crates/tui/examples/image-preview`; broader protocol research, no runtime/artifact integration |
| Public API modes, artifact references, generation/edit/inspect/export | Implemented subset | `packages/runtime/src/image-generation`, config, storage and core image-reference modules; section 1.1 |
| Native/hosted conversation image output and suppression | Planned | Not enabled by this implementation; existing provider handling is unchanged |
| OAuth/API-key coexistence | Partial | Environment image key coexists with stored chat OAuth without writes; stored v2 migration/UI remains [planned](./auth.md#9-credential-coexistence-for-image-generation-proposed) |
| Codex OAuth image route | Implemented; generation live verified | Section 1.2; existing OAuth, `gpt-image-2` request, saved PNG and model-input restoration |
| Codex Sunburst/Flare selection | Unverified execution | Exact model requests supported; no effective-model claim or fallback |

### 1.1 Implemented public API slice

- `/image-model` opens a mode/provider/model picker and, for OpenRouter, an
  endpoint picker. `/image-model status`, `off`, `builtin [model]`,
  `openai <model>` and `openrouter <model> <endpoint>` are explicit alternatives.
  Selection never changes `/model` or chat auth. Save requires confirmation for
  enabled modes and an idle runtime. Project configuration replaces the entire
  image block; unrelated raw config fields are retained. This is block override
  semantics, not a cross-process configuration transaction.
- Absent configuration is off. `custom` supports OpenAI public Image API and
  OpenRouter dedicated Image API. OpenAI API-key `builtin` uses the public Image
  API with no `OPENAI_BASE_URL` override. OpenAI Codex OAuth `builtin` uses the
  separate route in section 1.2. Other builtin providers and hosted/native image
  output are unavailable; no speculative paid probe or fallback occurs.
- OpenAI selectable image IDs are `gpt-image-2.5-sunburst` and
  `gpt-image-2.5-flare`. OpenRouter uses unpaid `/images/models` discovery and
  endpoint-specific capabilities with `provider.only` and `allow_fallbacks:false`.
  A five-minute memory catalog may be shown stale on refresh failure; endpoint
  capabilities are fetched again before generation. Discovery/selection does
  not prove account access or billing entitlement.
- `api_key_env` is an exclusive environment-variable selector. Otherwise use
  a stored v1 API key, then the standard provider environment key; never use
  OAuth for custom images or write auth.json while resolving image credentials.
  A stored chat OAuth session can coexist with an environment image API key.
  Stored auth v2 migration and a separate image-key entry UI remain planned.
- Allowed options: OpenAI `model` (builtin only), `size`, `quality`; OpenRouter
  `endpoint`, `quality`, `resolution`, `aspect_ratio`. See
  `packages/config/src/image-generation.ts` for the strict accepted values.
  Literal keys, arbitrary URLs, headers and unknown options are rejected.
- `image_generate` requests one image, or uses explicit ordered URL/file/artifact
  references subject to route-specific limits (section 1.3); `image_inspect`
  revisits an artifact; `image_export` creates a new
  PNG in an existing workspace directory without overwriting. Generation and
  export enforce permissions internally, including direct `tool.call`. No
  automatic retry occurs; cancellation/timeout may still have incurred a charge.
- The initial output subset is PNG, noninterlaced, 8-bit, at most 8 MiB,
  4096 pixels per side and 16 MP. CRC/structure and bounded decompression are
  validated before saving. OpenRouter omits unadvertised `output_format` and
  relies on the provider default; a non-PNG result is rejected without conversion
  or retry, potentially after a charge. Not every catalog image model fits this
  subset. Original bytes are never re-encoded or overwritten.
- Workspace-scoped originals and validated metadata live under
  `<sessionsDir>/image-artifacts/<sha256(workspace-root)>/codelia-image-UUID/`.
  Hashes, dimensions, provenance, parent IDs and reported usage are retained;
  unknown effective model/cost remain unknown. No automatic TTL/GC is implemented.
- Durable `ContentPart.image_ref` resolves only at the model-request boundary.
  Images remain actual inline input as history grows, preserving previous prefixes;
  missing/corrupt saved bytes abort the request rather than replacing prior image
  parts with text. There is no fixed aggregate 12 MiB history-image budget. Explicit compaction resets
  the prefix. Without an image resolver, refs become explicit unavailable text.
  Conversation vision capability is still required; selecting
  an image backend does not add vision support to a text-only chat model or
  silently switch it. Compaction uses text descriptions and retains up to 16
  recent references for explicit inspection. History/session logs retain IDs,
  not generated base64. References outside that registry are not a full catalog.
- `/image-artifact <id>` reads bounded bytes via RPC and opens the existing local
  preview controller, including over SSH. Runtime-host paths are never treated
  as client-local paths. Automatic preview/popover and artifact browser are not
  implemented. `/image [path]` still means a TUI-local path.
- Built-in image services are TUI-local runtime capabilities; side-effect-free
  custom embedding environments do not silently gain local auth/files/network.
  A custom-host image adapter contract remains planned.

Verification: focused Agent/factory/RPC tests use real artifact files and mocked
HTTP transport, including next-request vision input, disk resume, compaction,
permission denial, cancellation and export confinement. Public API live generation
remains **UNVERIFIED** without credentials; native terminal pixel quality remains
manual. An explicit one-image paid smoke is available after exporting the selected
provider's API key in the runtime environment:

```sh
INTEGRATION=1 CODELIA_IMAGE_LIVE=1 CODELIA_IMAGE_PROVIDER=openai \
  CODELIA_IMAGE_MODEL=gpt-image-2.5-sunburst \
  bun test packages/runtime/tests/image-generation-live.test.ts
```

For OpenRouter, additionally choose `CODELIA_IMAGE_PROVIDER=openrouter`, an exact
`CODELIA_IMAGE_MODEL` and `CODELIA_IMAGE_ENDPOINT`. These public provider modes read
only environment keys, never stored OAuth. The test deletes only its temporary
artifacts. There is one request and no automatic retry. Skipping is not validation.

### 1.2 Implemented Codex OAuth builtin

- With OpenAI OAuth chat selected, `/image-model builtin` uses the existing login
  without requesting an API key or changing the conversation model/auth method.
  The picker follows that auth mode; status includes `auth_mode: codex_oauth`.
- Default requested model is `gpt-image-2`, matching the pinned Codex tool.
  Explicit Sunburst/Flare requests are sent unchanged, but their acceptance and
  effective execution on this route remain **UNVERIFIED**. No model substitution.
- `codex.ts` uses fixed `chatgpt.com/backend-api/codex/images/generations` or
  `images/edits` JSON endpoints. Original references are image data URLs. Each
  execution obtains current tokens through the existing AuthResolver refresh
  flow; account pinning and fixed-origin checks precede image HTTP requests.
  Public API keys, custom base URLs and billing-route fallback are not used.
- Generation/editing reuse bounded PNG validation, immutable storage, permission
  checks and reference-backed model input. Refresh failures are redacted and ask
  for login, not an API key. Cancellation or timeout never causes automatic retry.

Live acceptance on 2026-09-13: a separately user-approved request for `gpt-image-2`
via existing Codex OAuth returned a validated 1254x1254 PNG (696675 bytes), saved
and reloaded the original, and resolved its reference into actual model image
input. The response did not report an effective model. The first approved request
also reached save, but its test failed due to an incorrect ToolResult-array
assertion; after a no-network regression fix, the separately approved second
request passed the complete smoke. There were no automatic retries. Test artifacts
were temporary and removed. This verifies that account/route at that time, not
universal entitlement, free usage, live editing or native terminal pixel quality.
Factory/RPC tests separately cover token refresh, edits, artifact transfer and
actual Agent next-request image materialization using mocked HTTP.

The following consumes one image request and requires fresh explicit permission:

```sh
INTEGRATION=1 CODELIA_IMAGE_LIVE=1 CODELIA_IMAGE_PROVIDER=codex \
  CODELIA_IMAGE_MODEL=gpt-image-2 \
  bun test packages/runtime/tests/image-generation-live.test.ts
```

Unlike public modes, `codex` reads the existing AuthStore OAuth login and uses
AuthResolver refresh. No API key is required. Live results use normalized
`ToolResult` (`{type:"parts",parts}`), not the unwrapped `tool.call` RPC shape.

### 1.3 Implemented explicit sources and LLM prefix stability

- `image_generate` accepts `prompt` and optional ordered `images`, whose elements
  are `{type:"url",url}`, `{type:"file",file_path}`, or `{type:"artifact",artifact_id}`.
  Omit images for text-only generation. Prompts can identify images by 1-based order;
  no implicit recent-conversation-image selection occurs. `view_image` inspection
  alone does not select an image for generation.
- Legacy `reference_artifact_ids` remains accepted, but cannot be combined with
  `images`, even if either is empty. Input definitions do not vary with current
  references or catalog updates, avoiding per-request tool-schema prefix changes.
- Schema and parent-ID persistence ceiling: 16. The public OpenAI route accepts
  up to 16; Codex is bounded to the inspected tool's 5; OpenRouter validates the
  selected endpoint's `input_references` descriptor before reading sources or
  generating. This is separate from entitlement or live acceptance verification.
- Source limits: 8 MiB each, 32 MiB combined, 4096px per side and 16 MP. PNG/JPEG/WebP
  signatures and dimensions are checked using `image-size`; this is header validation,
  not a full source-image decoder. Original bytes/MIME are preserved, never converted.
  Output remains the more strictly validated immutable PNG subset from section 1.1.
- Source acquisition is after the inner generation approval and route preflight.
  Local files use runtime-host paths, regular bounded reads and realpath confinement
  in minimal/trusted; full-access permits paths outside the logical sandbox.
  URLs use a separate unauthenticated HTTP(S) GET with public-IP socket lookup,
  standard ports, 15s timeout and streaming byte limits. Credentials, fragments,
  redirects and private/reserved destinations are rejected; no provider headers
  are sent. URLs may be retained in tool arguments, so must not contain secrets.
  Original Host/TLS servername are retained when connecting to validated DNS IPs.
  Proxy-configured Bun fails closed (its HTTP shim can otherwise use environment
  proxies despite `agent:false`); local file/artifact references remain available.
- Current adapters deliberately use acquired bytes (OpenAI multipart, Codex/OpenRouter
  MIME-correct data URLs). Arbitrary URL passthrough to the Codex image backend is
  not assumed verified. Failed retrieval never becomes reference-free generation.
  No new import tool, source artifact, provider, auth fallback or paid retry is added.
- URL/file references are transient inputs to a single explicit generation. Another
  explicit call may observe changed source contents. History replay never reads them
  again: it retains the original tool arguments and immutable generated `image_ref`
  outputs. Parent IDs retain only explicit artifact references in their supplied order.
- Core no longer rotates a latest-two image window: every prior resolvable image
  retains its original request content while history is appended. Missing/corrupt
  originals or fixed model views stop before model invocation;
  callers can explicitly compact and inspect again. Compaction is a deliberate prefix
  reset, with a textual registry rather than automatic image rehydration.

Verification: source reader and tool/adapter tests cover mixed ordered sources,
MIME-correct wires, 16-parent persistence, route/count/size rejection, permission
denial, cancellation, and sandbox/network restrictions. Agent tests compare full
previous model-input prefixes and tool definitions over three generated turns and
disk resume after the original source file is removed; core tests also compare
OpenAI/Anthropic serialized prefixes. No new live paid generation/edit or measured
`cached_tokens` claim is made. Server-side cache residency/routing remains outside
Codelia's control; tests establish input stability, not guaranteed cache hits.
An unpaid public PNG source download passed through the production reader on Bun
1.3.10 and the Node-target bundle on Node 24.14.0 on 2026-09-13; this verifies source
acquisition only, not generation or provider acceptance of references.

### 1.4 Implemented attachment identity and context accounting

- Submitted inline PNG/JPEG/WebP/GIF attachments are saved before history/logging,
  preserving bytes and MIME with `kind: attachment`, and replaced by durable refs.
  Remote URLs remain pass-through; ingestion never downloads them. Explicit artifact
  IDs can be supplied for editing; generation still rejects GIF before billing.
- Text/vision token estimates and encoded transfer bytes are separate. Model-family
  estimates use dimensions/detail, unknown models use a labeled heuristic; observed
  provider usage remains authoritative. Compressed bytes are not text tokens.
- No cumulative 12 MiB history cutoff remains. Individual image safety limits and
  known provider payload checks remain separate from context-driven compaction.
  Provider preflight is not a guarantee of every transport's acceptance.

### 1.5 Implemented fixed model views and WebSocket recovery

Design review: reducing encoded image bytes is appropriate for cold resume and
full replay; retaining a healthy WebSocket reduces unnecessary full replays but
cannot alone fix an oversized cold request. JPEG quality 90 does not imply a 90%
size reduction or a proportional vision-token reduction.

- At new `image_generate`/`image_inspect` admission, generated opaque PNGs of at
  least 256 KiB are eligible for a same-resolution JPEG quality-90, 4:4:4 view.
  Attachments, transparent/animated images, small originals and non-shrinking output
  retain originals. There is no automatic screenshot/text classifier. Use
  `image_inspect original=true` for fine text or exact pixels in generated images.
- Storage uses lazy-loaded `sharp` for bounded off-thread decoding/encoding
  (16 MP, 15-second processing timeout), then stores immutable view bytes and
  metadata in `<artifact>/jpeg-q90-444-v1/`. Original files and metadata never change.
  History stores `image_ref.model_view` with version, MIME, hash and byte size.
  Concurrent first admissions converge on the same persisted view. Version changes
  must preserve existing view files and references; no automatic view GC exists.
- Replay reads only the representation named by that history reference. A legacy
  ref without `model_view` always means original bytes, even after a view exists.
  Missing/corrupt views stop replay; do not rebuild or silently fall back. Editing,
  export and TUI RPC previews continue to read the original via `store.read`.
- If generation and original save succeeded but initial view preparation fails,
  return the saved ID and an original reference with an explicit warning. Do not
  hide the saved result or invite a second paid generation. This does not alter
  references already admitted to history.
- Do not migrate live history in place. To recover old oversized history, explicitly
  compact and inspect only needed saved IDs; these new inspections can use views.
  Input stability applies to append/replay with unchanged schemas and settings;
  upgrading tool definitions can independently invalidate cached prefixes.
- Healthy OPEN sockets no longer expire after 30 seconds. Socket-state checks,
  strict-prefix chaining and 10-minute idle-session eviction remain. Actual stale
  connections retain bounded reconnect handling. Fixed `websocket_mode=on` does
  not silently switch to HTTP.
- Native/wrapper close code 1009 becomes a transport-specific typed size failure.
  In `auto`, use HTTP fallback with full logical input, reset the WS chain and
  temporarily disable WS for that session. In `on`, retain non-retryable validation
  failure without resend/fallback, including after reconnect. HTTP acceptance is
  not guaranteed, and transport switching does not reduce history size. Do not
  invent a universal server byte threshold from one observed failure.

Verification includes actual encoding/storage/reload, legacy refs, concurrent
admission, corruption/symlink rejection, original preservation, transfer estimates,
and mocked WebSocket chaining/1009 behavior. No live paid request or actual cache-hit
acceptance is implied. Same-resolution lossy visual quality remains a manual check.

## 2. Modes, execution kinds, and availability

### 2.1 User-facing modes

| Mode | Behavior | If unavailable |
| --- | --- | --- |
| `off` | Disable image-generation tools and native image output | Show disabled state |
| `builtin` | Use a verified image capability of the current conversation connection | Expose no generation path; show reason; ordinary chat can continue if output restrictions are enforceable |
| `custom` | Expose a function tool bound to the configured image provider/model | Show config/auth failure; no alternate generation route; ordinary chat can continue |

- Proposed default: `off`, preserving existing behavior without implicit spending.
- No automatic fallback across modes, auth methods, accounts, selected image
  models, or billing routes. A failure must not cause a separately billed retry.
- Determine capability from provider, conversation/image model, auth method,
  endpoint, transport, execution kind, and relevant options. Unknown is unavailable.
- Resolve and pin one image path before each run. Connection/config changes apply
  at the next safe run boundary, not halfway through an in-flight operation.
- In `custom`, changing the conversation model does not change the image backend.
- In `off`/`custom`, suppress the conversation model's own native image output and
  hosted image tools. If a route cannot enforce that restriction, reject that
  incompatible connection/config combination rather than merely prompting it not
  to generate. An unexpected image is a visible protocol/policy error, not a reason
  to enable an unselected path.
- Availability discovery must not send speculative paid generation requests.

Expose requested mode separately from effective `disabled | available | unavailable`
state. Safe reasons include `unsupported_route`, `unverified_route`,
`missing_api_key`, `invalid_configuration`, and `approval_not_enforceable`.
Image failure must not masquerade as successful generation.

### 2.2 Internal execution kinds

These are adapter responsibilities, not additional user modes:

| Kind | Execution / output |
| --- | --- |
| `hosted_tool` | Provider executes an image tool within a conversation request |
| `provider_image_api` | Runtime calls an independent image endpoint; builtin may reuse the current connection if explicitly supported, custom uses its configured API connection |
| `native_output` | The invoked model returns image parts directly alongside assistant text |

Expose only the selected path. A builtin independent endpoint may need a runtime
function wrapper; that does not turn it into `custom`, which describes connection
selection rather than function-call syntax. Conversely, a custom tool may invoke a
multimodal image model internally. Its result is a real tool result, not a forged
assistant message. Deterministic adapter selection must be visible in settings;
ambiguous execution/billing alternatives require explicit selection, not fallback.

### 2.3 Models that generate images themselves

- Preserve native assistant role, part order, and text/image interleaving. Do not
  fabricate a function call merely to route native output through tool code.
- Keep provider continuation IDs/signatures and other required replay metadata
  separate from generic image bytes. Verify replay before enabling a route.
- Treat image input, image output, editing, and agent function calling as independent
  capabilities. A model suitable for custom image generation need not be suitable
  as the coding conversation model.
- Native image output may complete an assistant turn. Do not automatically initiate
  another generation just to make the model see its output. A verification pass,
  when needed, is a separate non-generating step with supported output restrictions.
- Normalize outputs from all kinds into image ContentParts/artifacts before history,
  logs, or TUI projection. Partial streaming images are not completed artifacts.

## 3. Configuration and model selection (proposed)

Minimal builtin configuration:

```json
{
  "version": 1,
  "image_generation": { "mode": "builtin" }
}
```

Builtin provider-specific options (illustrative public OpenAI route; this does not
assert Codex subscription support for the model or parameters):

```json
{
  "version": 1,
  "image_generation": {
    "mode": "builtin",
    "provider_options": {
      "openai": {
        "model": "gpt-image-2.5-sunburst",
        "quality": "high"
      }
    }
  }
}
```

Custom configuration reuses compatible provider credentials by default:

```json
{
  "version": 1,
  "image_generation": {
    "mode": "custom",
    "provider": "openai",
    "model": "<supported-image-model>"
  }
}
```

OpenRouter model selection with an optional separate key reference:

```json
{
  "version": 1,
  "image_generation": {
    "mode": "custom",
    "provider": "openrouter",
    "model": "<image-model-slug>",
    "api_key_env": "CODELIA_IMAGE_API_KEY"
  }
}
```

### 3.1 Validation and precedence

- `custom` requires nonempty `provider` and `model` supported by an image adapter.
  Chat connector support does not automatically supply an image adapter.
- Top-level `provider`, `model`, and `api_key_env` are custom-only. `api_key_env`
  names an environment variable, never a literal key. `off` accepts no options.
- `provider_options` is a namespaced, bounded JSON configuration surface for
  builtin/custom. Validate the active provider/model/route schema. Unknown active
  parameters or unsupported values are errors, never silently ignored.
- Options for another provider may remain stored for later switching, but are
  inactive and never forwarded. The UI identifies active and inactive namespaces.
- Do not blindly merge options into requests: deny credentials, headers, URLs,
  conversation model overrides, tool definitions, and other control-plane fields.
- Builtin `provider_options.<provider>.model` may select an image submodel only
  where the route supports it. A native conversation model cannot be silently
  replaced via this field. Show provider-managed model selection when appropriate.
- In custom, top-level `model` is authoritative; reject a second model selector in
  provider options. Optional tool `size`/`quality` override configured defaults
  only within the selected route's validated limits and approval policy.
- Global/project precedence follows the loader, but the image object is an atomic
  override, not a cross-provider deep merge. Mode changes replace the object;
  project `{ "mode": "off" }` overrides all global image settings.
- Arbitrary API URLs, inherited chat base URLs for custom generation, and generic
  named endpoint/account profiles are deferred. Provider options cannot bypass this.

### 3.2 Model picker and provenance

Provide a separate image-model picker for custom and for builtin routes that
support image-submodel selection; do not mix image-only models into the coding
conversation picker without agent capability checks. OpenRouter should offer
model discovery analogous to language-model selection, filtering by image output,
implemented transport, input/editing support, and definitive endpoint parameters.

Cache discovery with a timestamp and show stale/unavailable status. Permit a manual
model ID only under the same validation; a successful listing is not proof of
account access. Never test access with an unsolicited paid image. Record selected
provider, route, `requested_model`, and provider-reported `effective_model` if
available. Unknown effective model stays unknown; successful output alone does not
prove that a requested submodel was honored. Catalog and endpoint specifics live
in the [provider companion](./providers/image-generation.md).

## 4. Credentials and billing boundaries

Canonical coexistence/migration: [auth section 9](./auth.md#9-credential-coexistence-for-image-generation-proposed).

Builtin reuses the conversation connection's selected auth context. An independent
image endpoint must be explicitly defined by that connection's trusted adapter;
sharing a provider name is not authorization to send OAuth tokens to a public API.
No second image login or API-key fallback. Surface the effective route and known
billing context; builtin does not promise subscription entitlement.

Custom resolves an API key for the selected image provider:

1. Explicit `api_key_env`: that variable only; missing/empty is an error.
2. Otherwise, stored provider API key.
3. Otherwise, standard provider environment variable (e.g. `OPENAI_API_KEY`).
4. Otherwise, actionable `missing_api_key`. Offer key entry only in an explicit
   settings flow; headless operations must not wait indefinitely for prompts.

Never supply OAuth to custom image calls. Adding an image API key must retain OAuth
and chat selection. Invalid credentials must not trigger another key/account.
Environment lookup does not persist secrets or alter chat selection. Resolve in the
runtime environment, including SSH, not implicitly in the TUI host environment.

Keep keys/tokens out of project config, tool arguments, prompts, logs, and events.
Custom/non-local hosts inject auth through explicit adapters. Configuration is not
approval; show a change of chargeable route before enabling it and apply existing
permission policy. Missing usage or price information means unknown, not zero.

## 5. Common image and artifact contract

### 5.1 Three representations, one logical image

| Layer | Representation | Lifetime |
| --- | --- | --- |
| Original store | Immutable validated image bytes plus metadata | While referenced by retained sessions/artifacts |
| Durable conversation | Image ContentPart referencing an artifact, plus text/provenance | Session/replay lifetime; no duplicate base64 |
| Model request | Selected image parts materialized from artifacts/bounded buffers | Request lifetime; encoded as required by the provider |

Use the same logical image ContentPart for inbound/outbound images, not ordinary
text JSON, opaque `other`, or a path pretending to be an image. A runtime image
source may be transient bytes or an artifact reference; the serializer encodes it
as inline data, multipart, or an authorized provider file reference at the transport
boundary. Reuse bounded buffers where feasible, rather than cloning them per event.

The exact type evolution from today's `ImagePart.image_url` remains implementation
work: artifact references need explicit resolution and compatibility/versioning in
core history, storage, protocol, and client-tool contracts. Do not place an artifact
ID into an existing URL field and assume every provider understands it. Preserve
current inline-image callers while adding the reference-aware path.

Persist complete images before completed events. Normalize provider-returned image
URLs into owned bytes using bounded, policy-checked retrieval (including redirects
and credential forwarding); an expiring remote URL is not the permanent original.
Do not retain image data in raw response dumps, diagnostics, tool caches, or opaque
provider payloads. Replay metadata must not be a backdoor for duplicate base64.

### 5.2 Originals, export, and lineage

- All enabled generation paths auto-save to runtime-managed artifact storage. Local storage stays
  outside project files by default; remote/web hosts use an explicit artifact store.
- Stable, authorized artifact IDs identify originals. Store MIME, dimensions, byte
  size, integrity hash, creation time, session/operation identity, original/revised
  prompt when available, and provider/model/route provenance. Metadata inherits
  session privacy; never retain secrets or signed access URLs.
- `output_path` means an optional project export, not the original's identity.
  Export is a separately validated no-clobber write. Editing/deleting an exported
  file must not mutate the stored original. Snapshot authorized external inputs
  before using them as durable edit references.
- Each edit creates a new artifact with ordered parent artifact IDs and edit
  instructions. Revisiting a prior branch uses its ID, not a mutable filename.
- Preserve original bytes/format. Initial adapters may constrain generation to PNG;
  do not silently transcode all providers. Previews are derived artifacts/caches,
  not replacements for originals.
- Bound bytes, pixels, per-operation count, and session storage. Commit metadata
  and bytes consistently; pending/failed saves must not advertise a usable artifact.

### 5.3 Model viewing and editing

- For generated tool results, automatically include the completed image in the
  next image-capable model input, along with its artifact ID. No extra `view_image`
  call or human click is required to receive the image.
- Keep the current target and relevant comparison images in a bounded visual working
  set while discussing them. On unrelated work, drop their input payloads, not the
  stored original/reference. Selection is deterministic and visible to the model.
- Use artifact IDs for revisiting/editing; recent-image order is a convenience, not
  authoritative identity. Ambiguous targets require clarification. Before reasoning
  about an older target, rematerialize it for the conversation model when supported.
- A supported edit call receives the original target bytes/reference, not only a
  caption, a recollection, or a reduced preview. Store its resulting lineage.
- Preview/downsample for ordinary viewing within input budgets. Allow original-scale
  or crop inspection for small text/details, and expose which representation was
  supplied. Input budget exhaustion must not silently omit a required edit target.
- Including an image is not proof of correct visual assessment. Tasks needing QA
  require an explicit evaluation step. Image-input-incompatible models get a clear
  limitation and metadata, not a claim of inspection. Native output follows 2.3.

### 5.4 Retention, compaction, and resume

Compaction retains artifact references, current targets, lineage, and relevant text
summaries; it does not delete originals. Resume resolves images needed for the next
request instead of loading all historical bytes into memory. Missing originals are
visible errors, never an instruction to silently regenerate a similar image.

Keep originals while any retained session, fork, or artifact lineage references
them. Garbage-collect only unreferenced artifacts after explicit session deletion
or storage cleanup, honoring in-flight read/write leases. Automatically evictable
items are decoded buffers and reconstructible previews. Warn/block new generation
when a storage budget is exhausted rather than evicting referenced originals.
Specify numeric byte/pixel/count budgets and orphan-cleanup recovery before release;
never interpret an unspecified limit as unlimited. Exported user files are not GC
owned. Remote retention/deletion must implement the same contract through adapters.

### 5.5 Custom tool execution

Proposed function tool: `codelia_generate_image`. Its schema describes supported
operations/defaults/limits and is bound to configured provider/model/auth, not
model-selected credentials. Initial input is required nonempty `prompt`, optional
export `output_path`, and supported `size`/`quality`. Initial generation requests
one PNG; editing is a follow-up capability with explicit artifact references.
Masks, batches, and arbitrary endpoints are not required for MVP, but lineage and
input representation must not block later editing support.

Preflight options, auth, policy, artifact capacity, and optional export path before
network submission. Generate with cancellation/transport bounds; validate media,
bytes, and pixels; persist original atomically; then export if requested. Recheck
sandbox/path safety at write time against races and symlinks. Return image parts
and bounded artifact metadata. If export fails after the original is saved, report
both facts and permit export retry without regenerating or charging again.

## 6. Approval and replay across execution kinds

Hosted tools/native output can execute before any local function-call approval.
Authorize image availability and input data disclosure before the model request.
If policy requires per-call approval that a route cannot enforce, mark that route
unavailable; do not bypass approval because it is builtin. Independent endpoints
use the normal local tool/preflight boundary, even when mode is builtin.

All kinds use the same artifact pipeline. Preserve genuine assistant/tool roles,
part ordering, provider operation IDs, and continuation metadata. Support multiple
images in hosted/native responses with per-image and per-run bounds. Incremental
previews are transient and must not generate duplicate completed artifacts.

Verify request reconstruction from artifact-backed history, cross-provider model
switching, and session resume before enabling a route. Nonportable provider state
must be handled explicitly; do not replay foreign IDs/signatures to another
provider or substitute text for unsupported image replay. Verify HTTP/WebSocket
separately when both exist. Enable editing only when original input, disclosure
policy, lineage, and continuation are tested; otherwise constrain the route to
generation or keep an unconstrainable route unavailable.

## 7. Failures, cancellation, and usage

- Preflight failure or denial produces zero image requests, including hosted/native
  image exposure in the surrounding conversation request.
- Distinguish refusal, auth failure, rate limit, transport/decoding failure,
  persistence failure, export failure, and cancellation. No fabricated saved paths.
- Remote generation may incur cost despite cancellation or failed persistence.
  Cancellation does not prove the server stopped or a charge was refunded.
- No blind retry after ambiguous submission/timeout. Retry only with verified
  idempotency or evidence of nonacceptance; otherwise require a deliberate new
  operation. Apply this to surrounding hosted/native model requests too.
- Keep partial-save cleanup and completed-artifact identity idempotent. Missing
  files on resume must not trigger regeneration. Preserve successful artifacts
  when a sibling result fails and report partial completion explicitly.
- Record available usage and requested/effective model separately. Separate custom
  image cost from chat usage; do not count hosted/native usage twice. Unknown
  pricing/usage stays unknown and must not be inferred from requested model alone.

## 8. Package and UI ownership

- `packages/config`: schema, provider option validation, atomic merge semantics.
- `packages/runtime/src/auth`: coexistence and purpose-aware credential selection.
- `packages/core/src/llm`: provider mapping, native/hosted parsing and replay; no
  concrete filesystem or secret access. Image sources resolve through explicit
  interfaces, not a global store/service locator.
- `packages/runtime`: composition, custom adapters/tools, policy, lifecycle, visual
  working set selection, and artifact/UI projection through host adapters.
- `packages/storage`: concrete artifact persistence, retention, and integrity.
- `packages/shared-types` / `packages/protocol`: stable cross-boundary image
  references, metadata, status, and usage; no provider payload duplication.
- `crates/tui`: settings, image model picker, safe auth prompts, status/access UI.

Respect embedding and delegated-tool caps. Image support must not widen host
filesystem/network/credential permissions or introduce a generic plugin framework.

### 8.1 TUI image fallback (required for initial image support)

The initial TUI does not render pixels. Display each persisted image from runtime
metadata, without requiring the model to mention it. Render both tool/native images
and preserve surrounding text order. Illustrative output, not implemented bindings:

```text
Image saved: codelia-image-001
PNG | 1024 x 1024 | 1.2 MiB
Location: local runtime
Artifact: codelia-image-001
Export: /workspace/project/generated/banner.png
Actions: Open externally | Copy path
```

- Show ID, save/export status, MIME/format, dimensions, bytes, and local/remote
  location. Omit unknown fields. Show original location even when no export exists.
- Provide readable full path/access text. Clickable terminal links are optional;
  wrapping/truncation must still allow inspection/copy of the complete value.
- Only expose supported actions. Local external-open requires a trusted opener,
  validated artifact target, and explicit user action; never shell-evaluate model
  text or automatically launch a viewer after generation.
- Clipboard/opener failure is visible. If unavailable, preserve plain/selectable
  text and an explanation; do not show dead actions or false success.
- SSH paths belong to the remote runtime. Show a safe runtime label; never turn a
  remote path into a client-local file link or open it on the user's machine.
- Local opening of remote images requires a supported, user-requested transfer
  first. When transfer is unavailable, say so and show the remote path.
- Download links require a host-authorized artifact mechanism. Never invent public
  URLs, start a file server, or upload merely to enable clicking. Resolve expiring
  access on action, not in permanent logs; report expiry/auth failures visibly.
- Escape untrusted labels, filenames, and terminal controls. Link/open targets come
  from validated metadata; image text must not inject terminal escape sequences.
- Distinguish generating/saving/completed/failed and unavailable-on-resume. No open
  action before persistence; a failed export does not hide the saved original.
- TUI receives metadata, not image base64 in text. Model inputs still use image
  ContentParts. Human viewing, model image receipt, and successful QA are separate.

Inline terminal graphics and remote transfer are not prerequisites for initial
image support; the textual fallback and accurate access status are prerequisites.

### 8.2 Local image preview (implemented separately)

Normal TUI builds now include a `ratatui-image` small-panel/modal preview through
`/image [local-path]` and `Alt+I` for composer attachments. See the
[production preview contract](tui-image-preview.md) for controls, bounds, protocol
selection and checks. Decoding/encoding run on one bounded worker. Default
halfblocks never query stdin or mutate tmux; explicit Kitty is restricted to
alternate mode outside multiplexers with safe OS cell metrics. Runtime dialogs
preempt preview input and graphics never enter the durable/native transcript.

Local file preview alone does not generate images or submit them to the model.
Sections 1.1-1.2 separately implement generation/artifacts/model image input and
explicit remote artifact transfer; inline history thumbnails remain planned.
Native pixel quality/visual cleanup still requires real-terminal acceptance.

The standalone [image preview lab](../../crates/tui/examples/image-preview/README.md)
remains available behind the `image-preview` feature and shares the bounded
decoder. It retains broader protocol detection experiments, demo images and its
own lifecycle. Unlike production, the lab refuses tmux before Picker construction
and exits on unanswered capability queries rather than starting competing readers.

## 9. Future implementation sequence

1. Extend route-specific acceptance beyond the implemented sections 1.1-1.2.
   Codex Sunburst/Flare requests remain explicitly unverified, never substituted.
   Additional provider routes require their own contract and auth evidence.
2. Implement stored credential coexistence/migration and image-key entry without
   changing selected chat auth. Existing OAuth builtin does not require migration.
3. Extend implemented references/immutable artifacts/replay/working sets with
   reference-aware retention/GC and a complete artifact browser.
4. Add hosted/native output adapters and suppression separately from standalone
   API generation, preserving roles and text/image ordering.
5. Extend existing TUI settings, edit lineage and explicit remote transfer with
   optional automatic preview/access UI. No implicit route or billing switch.

## 10. Verification / acceptance gates

Automated implementation checks must cover:

- Mode/default/atomic override validation; provider-option isolation, forbidden
  fields and unsupported values; no cross-mode/model/auth/billing fallback.
- Capability matrix, native suppression in off/custom, independent image versus
  agent-tool capabilities, route pinning, and discovery failure/staleness behavior.
- Auth v1 migration, malformed versions, OAuth/key coexistence, unchanged chat
  selection, explicit environment precedence, and concurrent refresh/logout writes.
- ContentPart roundtrip for inline/reference sources, assistant text/image order,
  real tool-result roles, native replay, and provider-specific metadata isolation.
- Auto image input after generation, working-set budgets, old-target rematerializing,
  exact-original edit input, preview/original distinction, ambiguity, and no fake QA.
- Atomic original persistence, no-clobber export, changed-export independence, URL
  retrieval policy, byte/pixel/count limits, races/symlinks, and partial cleanup.
- Resume/compaction/forks/lineage and GC leases; quota pressure; missing originals;
  no base64 in durable logs, raw provider payloads, diagnostics, or tool caches.
- Zero network on denial, hosted/native request gating, cancellations/ambiguous
  timeouts with no duplicate charges, failed export retry without generation,
  partial multi-image success, unknown usage, and no double counting.
- Text-only TUI with multiple images, narrow widths, long paths, missing metadata,
  surrounding text, safe open/copy failures, and terminal control escaping.
- SSH ownership, capability-gated transfer, expired access, deleted artifacts, and
  model image input independent of TUI pixel/clipboard/opener capabilities.

Real API tests are opt-in with `INTEGRATION=1`, explicit credentials and cost consent.
For each enabled route, generate, decode/inspect the original, verify model image
input, export, resume, and test subsequent conversation. Verify selected image
models where provider evidence exists; do not infer the effective model from image
appearance. Test OAuth chat plus API-key images without replacing chat credentials.
Mocks do not establish subscription entitlement, billing, model selection, or live
endpoint compatibility. Numeric limits, replay/schema migration, and route evidence
are release gates, not assumptions to leave to an unbounded default.

## 11. Related contracts

- [Provider matrix and Codex research](./providers/image-generation.md)
- [Auth](./auth.md)
- [Runtime environment](./runtime-environment-contract.md)
- [UI protocol](./ui-protocol.md)
- [TUI remote runtime](./tui-remote-runtime-ssh.md)
- [Storage layout](./storage-layout.md)
- [Approval modes](./approval-mode.md)
- [Provider retry and failures](./providers/retry-and-failures.md)
- [Search tool](./search-tool.md): image routing does not inherit search fallback.

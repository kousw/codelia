# Image Generation: Provider Matrix and Codex Research

Status: Public API and Codex OAuth integration; external snapshot checked 2026-09-13.

This is the evidence companion to the [image generation contract](../image-generation.md).
A documented external API is not an implemented Codelia feature, verified account
entitlement, or a promise that every provider model accepts the same parameters.
A user-approved Codex OAuth generation smoke passed on 2026-09-13; public API-key
generation and other Codex model selections are not live-verified. See section 2.2.

## 1. Scope and provider inventory

The current local chat-provider inventory is OpenAI, Anthropic, OpenRouter,
Moonshot, Z.ai, and xAI (`packages/runtime/src/auth/resolver.ts`). Google remains a
planned direct chat connector; see [provider overview](./README.md). Image support
below is a separate capability inventory, not an extension of the chat allowlist.

| Provider | External capability observed | Image-model examples / selection | Codelia integration status |
| --- | --- | --- | --- |
| OpenAI public API | Independent Image API and Responses hosted image tool [O1] | `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare`; separate image-model selection | Public Image API custom and API-key builtin implemented; hosted not implemented; paid live access unverified |
| OpenAI Codex connection | Public Codex source includes an independent image client using current provider/auth [C2] | Default request `gpt-image-2`; Sunburst/Flare exact selection accepted locally but execution unverified [C1, C3] | OAuth builtin generation/edit implemented; generation/save/reload/model input live verified requesting `gpt-image-2`; effective model unreported |
| OpenRouter | Dedicated image generation/discovery API [R1]; hosted image server tool marked Beta [R2] | Discover image model slugs and per-endpoint capabilities rather than hardcode a complete list | Custom PNG picker/adapter implemented with pinned endpoint; hosted/native unavailable; paid live access unverified |
| xAI | Independent image generation and a conversation image tool documented [X1] | `grok-imagine-image-2.0` appears in current examples | Planned custom; builtin requires route verification |
| Z.ai | Image generation endpoint [Z1] | `glm-image`, `cogview-4-250304` | Planned custom adapter; hosted/native generation not established here |
| Anthropic | Current Claude models accept images and produce text [A1] | No native image-output model established in that overview | Keep builtin generation unavailable; custom may call another provider |
| Moonshot | Kimi image-understanding documentation [M1] | This review did not establish a documented image-generation endpoint/model | Unknown generation support; do not infer from vision input |
| Google (future direct connector) | Gemini image generation with interleaved text/image output [G1] | Select a documented image-capable Gemini model; not every Gemini model | Planned native-output integration; direct chat connector also remains planned |

Unknown means this review lacks affirmative evidence, not that an API cannot ever
exist. These examples are not exhaustive or stable defaults. Recheck account,
model, endpoint, transport, format, and option support before enabling a route.
Do not assume a coding/subscription plan covers an otherwise public image API.

## 2. OpenAI/Codex: corrected execution and model-selection boundary

### 2.1 Public API versus subscription connection

OpenAI documents image generation through its public Image API and the hosted
Responses tool, including explicit Sunburst selection [O1]. Codex documents
ChatGPT sign-in versus API-key authentication as distinct usage paths [O2].
Codelia must not treat a subscription token as a public image API credential.

The earlier design assumption that Codex images necessarily mean a Responses
hosted tool was too narrow. The independent backend below is evidence of another
client execution path, not proof of its availability to Codelia or of arbitrary
public API access within a subscription.

### 2.2 Pinned source observations

Inspected Codex commit: `36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564`
(2026-09-13). This is a repository snapshot, not a claim about every released client.

- The image tool binds generation/editing to `gpt-image-2`; its arguments select a
  prompt and image references, not another model [C1].
- `CodexImagesBackend` builds its image client from the active provider/auth and
  sends standalone generation/edit requests. It is not itself a hosted-tool
  declaration [C2].
- The request types carry a string model field; the examined image response type
  does not report an effective model [C3]. Thus changing client code to send another
  name is technically distinct from server acceptance and faithful model selection.

Codelia now implements that separate OAuth route in `image-generation/codex.ts`:
fixed backend origin, AuthResolver refresh, account headers/pinning, JSON generation
and original-image edits, no API-key fallback. A user-approved live request on
2026-09-13 returned a validated PNG (1254x1254, 696675 bytes), saved/reloaded it and
resolved actual model input. Requested model was `gpt-image-2`; effective model
was unreported. The first request reached save but exposed a smoke assertion bug;
the separately approved second request passed the repaired complete verifier.
No automatic retries were made. Live editing is still unverified; deterministic
factory/adapter tests verify its exact JSON/auth/original-byte contract. See
[implementation and acceptance record](../image-generation.md#12-implemented-codex-oauth-builtin).

Sunburst/Flare on the Codex route remain **UNVERIFIED**. Verification needs a documented
route/entitlement contract and explicit model-selection evidence where available,
not image appearance or HTTP success alone. Preserve `requested_model` separately
from unknown `effective_model`. If the route cannot guarantee custom selection,
show provider-managed/fixed selection rather than advertise arbitrary models.

### 2.3 Image visibility and storage lessons

The inspected tool saves decoded image data and returns the generated image as an
image-bearing tool response, allowing subsequent model input without a separate
view tool. Editing can select explicit file references or recent conversation
images. Its tool telemetry uses a short placeholder instead of image bytes [C1].

That is not evidence that all Codex durable history is payload-free. OpenAI's
published hatch-pet skill warns that generated image data can remain embedded in
the invoking rollout even after a file is saved or deleted, and recommends bounded
worker-based workflows for that use case [C4]. This is an operational note, not a
complete audit of all Codex persistence paths. Do not adopt its worker strategy as
mandatory Codelia delegation policy.

Codelia's chosen approach differs: immutable originals plus artifact references in
history, automatic image materialization for model input, explicit edit lineage,
and no base64 duplication in telemetry/raw payloads/session logs. File export is
not a substitute for managing history payloads. See main spec section 5.

Explicit URL/file/artifact references and prefix-stable history are implemented in
main spec section 1.3. Current generation adapters materialize URLs to bounded bytes;
provider-side arbitrary URL retrieval is not presumed verified. Core no longer
rewrites earlier images when a third image arrives. Deterministic prefix comparisons
are not a measurement of provider `cached_tokens` or KV-cache retention. Section
1.5 adds versioned same-resolution JPEG model views for new generated-image refs,
while editing/export preserve originals and legacy refs never change silently.
Healthy WebSocket reuse now follows socket state and the 10-minute session TTL;
1009 falls back to HTTP with full logical input in `auto`, without another WS
attempt; `on` retains an actionable terminal size failure. HTTP acceptance of
oversized history remains unverified and transfer size is not reduced by fallback.

## 3. OpenRouter model selection and parameter handling

Observed public contract [R1]:

- Dedicated discovery: `GET /api/v1/images/models`; general model discovery can
  filter for image output.
- Generation: `POST /api/v1/images` with an image-model slug.
- Model-level capabilities aggregate possible endpoints; per-endpoint records
  provide the definitive supported parameters. Formats and streaming vary.

The hosted image server tool is a separate Beta surface with an image-model
setting and additional model-dependent options [R2]. Neither surface proves
compatibility with Codelia's existing Responses-based chat connector. Native
assistant image output, if used via OpenRouter, needs its own route/serialization
verification rather than an assumption that all endpoints are interchangeable.

Proposed Codelia policy:

1. Offer image-model discovery/picking like the language-model picker, but filter
   by implemented image adapters and required input/output capabilities.
2. Validate parameters against the actual selected endpoint, not only the union
   of all endpoint capabilities. Show provenance, known pricing, and refresh age.
3. Use builtin provider options for a hosted image submodel only on a verified
   current OpenRouter connection; custom selects its image model independently.
4. Separate `openrouter` as the credential/billing provider from the upstream model
   vendor/endpoint. Never request an upstream vendor key solely from a model slug.
5. Expose routing/fallback behavior rather than silently relaxing an explicit image
   model or parameter request. Preserve policy restrictions through gateway routing.

## 4. Implementation evidence required per enabled route

Maintain a support record with provider, model, auth method, trusted endpoint,
transport/API family, execution kind, supported image options, input/output formats,
image input/edit support, agent tool support, and verified date. Keep these states
separate: externally documented, locally implemented, live verified, unavailable.

Release evidence must cover actual generation and saved-original decoding, exact
input identity for edits, replay with image references, native/hosted role and part
ordering, bounded output, credential isolation, selected-model provenance, and
usage behavior. Tests using mocks or a different auth route cannot promote a
subscription route to verified. The local Codex generation acceptance above does
not establish live edits, other models, free usage or every account's entitlement.

## 5. Primary sources

All web documentation below was checked on 2026-09-13; non-pinned pages may change.
Sources support external observations only, not the proposed Codelia behavior.

- [O1: OpenAI image generation guide](https://developers.openai.com/api/docs/guides/image-generation)
- [O2: Codex authentication](https://developers.openai.com/codex/auth)
- [C1: Codex image tool at the inspected commit](https://github.com/openai/codex/blob/36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564/codex-rs/ext/image-generation/src/tool.rs)
- [C2: CodexImagesBackend at the inspected commit](https://github.com/openai/codex/blob/36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564/codex-rs/ext/image-generation/src/backend.rs)
- [C3: Codex image API types at the inspected commit](https://github.com/openai/codex/blob/36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564/codex-rs/codex-api/src/images.rs)
- [C4: OpenAI hatch-pet skill, storage controls (moving main)](https://github.com/openai/skills/blob/main/skills/.curated/hatch-pet/SKILL.md)
- [R1: OpenRouter Image API and model discovery](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)
- [R2: OpenRouter image generation server tool](https://openrouter.ai/docs/guides/features/server-tools/image-generation)
- [X1: xAI image generation guide and conversation-tool reference](https://docs.x.ai/developers/model-capabilities/images/generation)
- [Z1: Z.ai image generation API](https://docs.z.ai/api-reference/image/generate-image)
- [A1: Anthropic models overview](https://platform.claude.com/docs/en/models/overview)
- [M1: Kimi vision guide](https://platform.kimi.ai/docs/guide/use-kimi-vision-model)
- [G1: Google Gemini image generation](https://ai.google.dev/gemini-api/docs/image-generation)

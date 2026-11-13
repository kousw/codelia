# Gemini / Google native provider

Status: **Implemented; chat/tool and image generation live-smoked** (2026-11-02).
Native chat and custom image routes use `@google/genai` 2.32.0 Interactions.
Carbon/Hydrogen selection and request fixtures added 2026-11-13; live access to
these two models has not been verified.

## Implemented Codelia boundary

- `ChatGoogle` streams through Interactions, preserves signed thought/call steps
  in local history, and requires a terminal completion event. Runtime admits
  Google API-key auth, lists the static chat catalog, and creates the connector.
- The custom image route uses Interactions with explicit model, size, aspect
  ratio and optional JPEG output selection. Final PNG/JPEG blocks are saved as
  separate immutable originals. `/image-model` selects the route.
- Static catalogs establish local selection only. Account/model availability,
  billing, quality and latency require live checks.
- Named HTTP providers speak Responses; a Gemini URL cannot be substituted
  without a compatible protocol. OpenRouter is a separate auth/billing path.

## API and authentication choice

Use Google's [Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview)
through the official `@google/genai` JavaScript SDK 2.32.0. Google recommends Interactions
for new work; `generateContent` remains supported but is legacy.

Interactions defaults to `store=true`. Codelia chat and image routes send
**`store=false` explicitly** and retain Codelia-owned local history.
This rules out `previous_interaction_id` and background execution. Google
recommends server-managed state for efficiency, so measure stateless multi-turn
quality and cost before release. An opt-in server-state mode would require a
separate retention and resume design.
[Interactions overview](https://ai.google.dev/gemini-api/docs/interactions-overview),
[stateless function calling](https://ai.google.dev/gemini-api/docs/function-calling).

Use a Gemini Developer API key under Codelia provider id `google`. Pass the
resolved key explicitly to the SDK. For environment lookup, match Google's
documented precedence: `GOOGLE_API_KEY` wins over `GEMINI_API_KEY` when both are
set; Codelia's stored credential keeps its existing precedence over environment
keys. No silent gcloud, Vertex AI, consumer login, or Antigravity auth.
[API key documentation](https://ai.google.dev/gemini-api/docs/api-key).

## Chat model catalog

Register these stable text-output, function-calling models for native chat.
Use `gemini-3.8-flash` as the **Google-only** default; leave
other providers' defaults unchanged. A static catalog is not an account
entitlement check.

| Model | Role | Published limits | Thinking | Decision |
| --- | --- | --- | --- | --- |
| [`gemini-4-carbon`](https://aistudio.google.com/docs/models/gemini-4-carbon) | Deep coding/reasoning | Unified 1,048,576 input + thought + output tokens; synchronous output <=65,536 | low, medium (default), high | Include; GA 2026-11-10; no long decode or explicit caching |
| [`gemini-4-hydrogen`](https://aistudio.google.com/docs/whats-new-gemini-4-hydrogen) | Fast everyday coding/agents | Unified 1,048,576 input + thought + output tokens; synchronous output <=65,536 | low, medium, high (default), xhigh | Include; GA 2026-11-12; no long decode or explicit caching |
| [`gemini-4-argon`](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon) | Deep coding/reasoning | Unified 1,048,576 input + thought + output tokens; synchronous output <=65,536 | low, medium (default), high | Include; paid tier only; no long decode or explicit caching |
| [`gemini-3.8-flash`](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) | General agent default | 1,048,576 input; 65,536 output | low, medium (default), high | Include |
| [`gemini-3.5-flash-lite`](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) | Low-cost/high-throughput tasks and subagents | 1,048,576 input; 65,536 output | minimal (default), low, medium, high | Include; preserve its default if no effort is set |

These models accept image input; the chat route supports text
and image input, client function tools, and text output. Video/audio/PDF input,
hosted tools, structured output, and native image output need separate slices.
[Model catalog](https://ai.google.dev/gemini-api/docs/models),
[thinking levels](https://ai.google.dev/gemini-api/docs/thinking).

Do not promote old preview snapshots to the native chat picker:
`gemini-3-pro-preview` shut down on 2026-03-09,
`gemini-3-pro-image-preview` shut down on 2026-06-25, and
`gemini-3-flash-preview` remains preview. Defer older stable
`gemini-3.6-flash`, preview `gemini-3.1-pro-preview`, 2.5 models, Live/TTS,
embeddings, and managed agents until they have a distinct use case and tests.
[Deprecations](https://ai.google.dev/gemini-api/docs/deprecations).

## Initial image model catalog

The **Google image adapter** uses Codelia's existing `image_generation` custom
route and `/image-model` picker. Image-only models belong in that picker, not the
coding chat picker. It shares Google API-key auth with chat.

| Model | Role | Published input/output token limits | Image sizes | Decision |
| --- | --- | --- | --- | --- |
| [`gemini-nano-banana-2.1`](https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1) | General generation and multi-reference editing | 131,072 / 32,768 | 1K, 2K, 4K | Include; Google image default |
| [`gemini-3.1-flash-lite-image`](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image) | Low-latency, low-cost edits/generation | 65,536 / 4,096 | 1K only | Include; limit size options and test edit quality |
| [`gemini-3-pro-image`](https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-image) | Complex designs/precision editing | 65,536 / 32,768 | 1K, 2K, 4K | Include; premium choice |

Defer older stable `gemini-3.1-flash-image` (Nano Banana 2, useful for 0.5K)
and legacy `gemini-2.5-flash-image`; omit shut-down image previews. Review
the older stable model only if 0.5K or compatibility demand justifies another
tested route. Google's current [image guide](https://ai.google.dev/gemini-api/docs/image-generation)
recommends Nano Banana 2.1 as the current general model and distinguishes Lite
and Pro by speed/cost versus quality/control.

The image route uses Interactions with an image `response_format` and validated
model-specific `image_size` and `aspect_ratio`. Codelia validates and saves the **returned** bytes
and MIME as an immutable original, and export with the matching `.png`/`.jpg`
extension. Do not silently convert or change the requested format. Google's
[image guide](https://ai.google.dev/gemini-api/docs/image-generation) gives a
JavaScript `mime_type: "image/png"` example, while the
[Interactions API reference](https://ai.google.dev/api/interactions-api) lists
only `image/jpeg` for the output-format MIME enum. The current generated
[`@google/genai` type](https://github.com/googleapis/js-genai/blob/main/src/gaos/models/interactions/image-response-format.ts)
also names JPEG but permits other strings; that does not establish server
acceptance. The Codelia adapter supports both returned formats, while
The live API rejects explicit `image/png` with HTTP 400 `invalid_request` and
lists only `image/jpeg` as supported. The picker therefore offers Google
default or explicit JPEG. Returned PNG/JPEG originals remain supported; an
explicit JPEG choice is sent exactly and a mismatched response is rejected.
The documented 1K/2K/4K choices are available for Nano Banana 2.1 and Pro,
and 1K for Lite. The selected size is sent exactly without downgrading.
Prompt-only generation and explicit reference-image editing preserve
source originals and immutable output artifacts. Parse all `model_output`
blocks rather than relying only on `output_image`, which returns the last image. If multiple
final images are returned, save and report every artifact; extend the current
single-image tool result and designate the last final image as primary for
existing one-image consumers. Never silently discard extra outputs. Reject an
empty/malformed image response without a paid retry.
Set `store=false` and avoid hosted Google Search by default. Google's API can
return interleaved text and images and may not honor an exact requested image
count. [Image generation guide](https://ai.google.dev/gemini-api/docs/image-generation).

Generated-image artifacts preserve returned PNG/JPEG original bytes and export
with matching file extensions. The shared bounds are 32 MiB per image,
12,288 pixels per side, 20 MP, and 128 MiB combined reference bytes. The
Google image response transport is bounded at 192 MiB. These bounds cover
documented 4K square and 1:8 / 8:1 dimensions. Google references are capped
at 14; model-specific quality limits still apply. Peak memory and real API
payload behavior remain unmeasured. Do not silently transcode,
change the model, or fall back to another billed image route. Record requested
and provider-reported effective model separately when available.
[Codelia image contract](../image-generation.md),
[Google image guide](https://ai.google.dev/gemini-api/docs/image-generation).

## Chat integration contract

1. **Signed stateless replay.** Every `store=false` call needs complete ordered
   history: `user_input`, all model-produced `thought`, `function_call`, and
   `model_output` steps, and matching `function_result` steps. Preserve IDs and
   opaque signatures exactly, including empty thought summaries and parallel
   calls. Function results must match call ID and name. Define round-trip-safe
   mapping through `ReasoningMessage.raw_item`, assistant/tool metadata, and
   persistence; a text-only restore is insufficient.
   [Function calling](https://ai.google.dev/gemini-api/docs/function-calling),
   [thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures).
2. **Compaction and switches.** Replace only complete signed prefixes; do not
   leave orphaned results or partial steps. Preserve a complete recent signed
   suffix. Google says to resend earlier-model thought blocks after a model
   switch; verify against fixtures and opt-in live smoke. Block paths that cannot
   preserve required signatures rather than silently dropping them.
   [Thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures).
3. **Streaming and terminal states.** Accumulate typed `step.start`,
   `step.delta`, and `step.stop`, including incremental JSON tool arguments.
   Require `interaction.completed` and distinguish `completed`,
   `requires_action`, `incomplete`, `failed`, and `cancelled`; EOF alone is not
   success. Preserve cancellation and prevent replay after delivered output.
   [Streaming](https://ai.google.dev/gemini-api/docs/streaming).
4. **Reasoning and limits.** Map explicit Codelia `low|medium|high` to
   `thinking_level`. Hydrogen additionally preserves native `xhigh` and maps
   `max` to `xhigh`; all other registered Google models map `xhigh|max` to
   `high`. Emit a visible diagnostic only for actual fallback. Omit the
   parameter when no effort is explicitly set, preserving Carbon's `medium`,
   Hydrogen's `high`, and Flash-Lite's `minimal` API defaults. Do not send deprecated
   `thinking_budget`, `temperature`, `top_p`, `top_k`, or `candidate_count`.
   For all three Gemini 4 models, reserve synchronous output inside the unified context (a
   conservative 983,040 input tokens reserves 65,536 output). Output budget
   covers thoughts and visible output together.
   [Argon](https://ai.google.dev/gemini-api/docs/latest-model),
   [thinking](https://ai.google.dev/gemini-api/docs/thinking).
5. **Usage, errors, surfaces.** Normalize total input, cached input, total
   output, and thought tokens without double-counting; verify exact accounting
   in fixtures. Redact opaque signatures/errors. Wire auth, model listing,
   runtime factory, TUI, SDK embedding, resume, and child bootstrap together.
   Reject unsupported model/auth selections before saving them.
   Google does not offer Fast mode. An explicit `fast: true` selection fails
   before writing config or session state. When switching from another provider,
   an inherited boolean Fast setting is saved as `false`; older Google config
   with `fast: true` runs at the displayed `fast:off` setting. Ultrafast remains
   an error.

Gemini 4 output above 65,536 requires a separate long-decode execution path;
Codelia keeps synchronous output capped at 65,536 with automatic continuation
disabled. Background execution requires server storage and remains outside
the stateless chat boundary.
[Background execution](https://ai.google.dev/gemini-api/docs/background-execution),
[long decode](https://ai.google.dev/gemini-api/docs/long-decode).

## Release gates and unverified work

An unpaid `models.list` request listed all six selected models. After the user
added Prepay credit, ChatGoogle returned completed `OK` and `DONE` turns with
usage, and a forced `echo` function call completed a signed `requires_action`
turn followed by a completed tool-result turn. Google Flash Lite Image returned
JPEG for explicit JPEG and default-format 1K requests. Nano Banana 2.1 returned
one 1408x11712 JPEG for a 4K / 1:8 request; the original saved and reloaded
byte-for-byte. The requested size was sent unchanged, but output dimensions
were below the guide's 1536x12288 table value. A Nano Banana 2.1 edit using a
locally created 512x512 PNG reference returned JPEG. A 2x2 fixture first hit
Google's `image_recitation` block; that response did not establish an adapter
failure. Explicit PNG returned HTTP 400, so it is rejected locally before a
paid request. Other models, edit quality, multiple outputs, PNG return,
account tiers and performance remain unverified.

- Recheck the official guide/API-reference conflict if Google adds PNG output
  request support. Test both
  PNG and JPEG artifact save/read/export/model-input round trips, including
  MIME mismatch rejection and legacy PNG compatibility.
- Fixtures: signed single/multi-turn replay, empty summaries, parallel tools,
  image input, resume, compaction, model switch, cancellation, truncated stream,
  every terminal status, and usage accounting.
- Image adapter: exact model/option validation, reference bytes and lineage,
  output MIME and bounds, all returned image blocks, save/reload/edit, no
  accidental re-generation on artifact reuse, and auth isolation.
- Validate SDK support for signed stateless replay, streaming, and abort. Use a
  narrow alternate transport only if the SDK cannot satisfy the contract.
- Confirm model/account availability, limits, billing, latency, and tool/image
  quality with explicitly authorized paid live smokes. Research does not prove
  entitlement or live behavior.

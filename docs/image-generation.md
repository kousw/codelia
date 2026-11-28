# Image generation

Image generation is separate from the conversation/coding model. It is **off by
default**. Builtin supports your existing OpenAI Codex OAuth login without an API
key. Public OpenAI/OpenRouter/Google routes also support API keys. Selecting a
route does not prove account access or price.
Generation may be charged even if a request times out or is cancelled.

## Select and generate

1. For an existing OpenAI Codex OAuth conversation connection, no additional key
   is needed. For a **Custom** public API route instead, supply `OPENAI_API_KEY`,
   `OPENROUTER_API_KEY`, or `GOOGLE_API_KEY` (`GEMINI_API_KEY` also works when
   `GOOGLE_API_KEY` is unset) to the **runtime process** before starting Codelia
   (on the runtime host for SSH). An existing stored API key also works. Do not
   paste keys into chat or project configuration; custom keys do not replace chat
   OAuth.
2. Run `/image-model builtin` and confirm to use your current OpenAI login, or
   run `/image-model` and choose **Custom** for an independent provider/model.
   OpenRouter also requires an explicit endpoint, and Google requires an explicit
   image model. There is no automatic fallback. The selection is saved in your user configuration and applies across projects.
   If the current project already defines `image_generation`, including `{"mode":"off"}`,
   the command updates that project override.
3. Ask normally, for example: "Generate an orange-circle icon on a white background."
   The agent uses `image_generate` under the normal permission policy. This is
   a real generation tool, not a preview-only command.
4. The result includes a `codelia-image-...` artifact ID. Use
   `/image-artifact <id>` to open its preview. `Enter`/`Space` toggles small/modal;
   `Esc` returns to small then closes; `q` closes immediately.
5. Ask the agent to revisit an artifact (`image_inspect`), edit it using its ID
   (`image_generate` references), or export it to a new workspace `.png` file
   (`image_export`). Export requires an existing parent directory and never
   overwrites an existing file. Export paths refer to the runtime host.

Useful commands:

```text
/image-model status
/image-model builtin
/image-model off
/image-model openai gpt-image-2.5-sunburst
/image-model openai gpt-image-2.6-flare
/image-model openrouter <model-id> <endpoint-tag>
/image-model google <model> [1K|2K|4K [ratio [jpeg]]]
```

`/model` still selects the conversation model. `/image <path>` still previews a
TUI-local file, including when the runtime is remote. `/image-model builtin`
follows your OpenAI conversation authentication: Codex OAuth uses the dedicated
Codex image backend with existing token refresh and defaults to `gpt-image-2`;
API-key authentication uses the public Image API. Neither changes your chat model
or silently switches auth/account/billing routes. Codex Sunburst/Flare execution
is not yet live-verified; explicit selections are never replaced with another model.
OpenAI's 2.6 Sunburst and Flare can be selected for PNG generation and editing;
the 2.6 complexity, SVG, GIF and markup options are not exposed. Public API and
Codex OAuth access to 2.6 have not been live-verified.

The custom Google route uses the Gemini Interactions API with `store=false`.
Select `gemini-nano-banana-2.1` (general generation and reference editing),
`gemini-3.1-flash-lite-image` (1K only), or `gemini-3-pro-image` (1K/2K/4K). Codelia
validates `output_format` to accept only `"jpeg"` or Google's default (omitted)
because the upstream API rejects explicit PNG output selection, while returned
PNG and JPEG originals are both accepted. Google selections are not silently
replaced with another model or provider. Google edit quality and broader model
access remain unverified against live APIs.

## Configuration and authentication

The optional `image_generation` block replaces the entire global block at project
scope. Example with a separately named environment key:

```json
{
  "version": 1,
  "image_generation": {
    "mode": "custom",
    "provider": "openai",
    "model": "gpt-image-2.5-sunburst",
    "api_key_env": "MY_IMAGE_API_KEY",
    "provider_options": {
      "openai": { "size": "1024x1024", "quality": "low" }
    }
  }
}
```

`api_key_env` selects that variable exclusively. Without it, image credentials
resolve from a stored API key, then the standard provider environment variable.
OAuth is never used for custom images. Literal keys, arbitrary URLs, headers and
unknown provider options are rejected. Stored OAuth and API-key credentials for
the same provider can coexist, though there is no separate image-key entry UI.

For `provider: "google"`, `provider_options.google` accepts `image_size`
(`1K`, `2K`, or `4K`), `aspect_ratio` (for example `1:1` or `16:9`), and
`output_format: "jpeg"`. `gemini-3.1-flash-lite-image` accepts only `1K`.

## Use reference images

Ask the agent to use a public image URL, a runtime-local file, or a saved artifact:

```json
{
  "prompt": "Keep the character in image 1 and use the composition of image 2.",
  "images": [
    { "type": "url", "url": "https://example.com/character.png" },
    { "type": "file", "file_path": "reference.webp" }
  ]
}
```

For a generated image use `{ "type": "artifact", "artifact_id": "codelia-image-..." }`.
References are ordered and explicit; viewing an image does not automatically pass
it to generation. The legacy `reference_artifact_ids` input still works but cannot
be combined with `images`.

URL/file images are read in memory after approval, not saved as new artifacts or
inserted into old conversation messages. Only public HTTP(S) image URLs on standard
ports are accepted; redirects, credentials and private IP literals are rejected.
Direct connections also reject private DNS destinations. Do not include secrets
in URL query strings. Local paths refer to the
runtime host, including SSH, and retain normal sandbox restrictions.
URL downloads honor host-configured `HTTP_PROXY`/`HTTPS_PROXY`, `ALL_PROXY` fallback,
and lowercase equivalents. These proxies are trusted routes and control final
destination access; `NO_PROXY`/`no_proxy` bypasses retain direct DNS checks.
Proxy support requires Bun 1.4.4+, Node 22.21.x or Node 24.5+. Proxy failures are
reported without credentials and never trigger a direct-connection fallback.

## Conversation image size

Newly generated opaque images use a fixed JPEG quality-90 view for the conversation
model when it is smaller, retaining the same resolution and 4:4:4 color sampling.
Generation/editing references, exported files and TUI previews always use original
bytes. Attachments (including screenshots), transparency and small images keep
originals. For exact pixels or fine text in a generated image, ask to inspect it
with `original: true`.

Saved history is not rewritten: older references still use originals. WebSocket
error `1009` falls back to HTTP when `websocket_mode=auto`; `on` stops without
resending or switching transport. Fallback sends the full history and may still
exceed HTTP limits. Compaction/reinspection can reduce old image history, but
compaction itself may fail when inline images keep its request oversized. New
inspections of saved artifact IDs can use smaller views.
A missing/corrupt saved view is an error, not a reason to silently change old input.

JPEG quality is lossy and is not a percentage of bytes saved. Transfer savings do
not necessarily reduce image-token usage. Stable input helps cache reuse without
guaranteeing server-side cache hits.

## Limits and verification

- OpenAI/OpenRouter routes return one noninterlaced 8-bit PNG per request.
  OpenRouter models that return other formats are not supported: a non-PNG
  default is rejected, potentially after a charge. The Google route preserves
  returned PNG/JPEG originals and accepts up to four final images per request.
  Generated originals are limited to 32 MiB, 12,288 pixels per side and 20 MP on
  every route; oversized or unsupported output is rejected, possibly after usage
  is consumed.
- Reference count: up to 16 for public OpenAI/OpenRouter routes (OpenRouter
  endpoints may support fewer), 5 for Codex, and 14 for Google. PNG/JPEG/WebP
  references are limited to 32 MiB each, 128 MiB combined, 12,288 pixels per
  side and 20 MP; headers are validated without re-encoding. A failed source or
  unsupported count stops generation rather than silently omitting images.
  Generated originals are immutable and retained across sessions; there is no
  automatic cleanup. Keep artifact IDs to revisit older images.
- A vision-capable conversation model receives actual generated image input;
  image generation does not add vision to a text-only conversation model. The
  previous image inputs remain stable as history grows, rather than rotating old
  images into text and breaking the LLM input prefix. There is no fixed aggregate
  12 MiB history-image cap. Missing/corrupt image data or a transport size rejection
  stops the next model request; explicitly compact the conversation, then ask to
  inspect only the needed saved images again.
  Stable prefixes help cache reuse but do not guarantee server-side cache hits.
- The TUI transfers artifact bytes explicitly over RPC, including SSH. Graphics
  are transient, not embedded into permanent terminal history. Default rendering
  uses colored halfblocks; native terminal visual quality still needs manual
  confirmation.
- Automated tests cover the tools, runtime configuration/RPC, immutable
  files, history/model input and TUI transport with mocked HTTP. OpenAI live
  editing and public API-key generation remain unverified against live APIs;
  see the gated live test commands in
  [implementation and verification notes](../dev-docs/specs/image-generation.md#12-implemented-codex-oauth-builtin).

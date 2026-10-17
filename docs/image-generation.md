# Image generation

Image generation is separate from the conversation/coding model. It is **off by
default**. Builtin supports your existing OpenAI Codex OAuth login without an API
key. Public OpenAI/OpenRouter routes also support API keys. Selecting a route
does not prove account access or price.
Generation may be charged even if a request times out or is cancelled.

## Select and generate

1. For an existing OpenAI Codex OAuth conversation connection, no additional key
   is needed. For a **Custom** public API route instead, supply `OPENAI_API_KEY`
   or `OPENROUTER_API_KEY` to the **runtime process** before starting Codelia (on
   the runtime host for SSH). An existing stored API key also works. Do not paste
   keys into chat or project configuration; custom keys do not replace chat OAuth.
2. Run `/image-model builtin` and confirm to use your current OpenAI login, or
   run `/image-model` and choose **Custom** for an independent provider/model.
   OpenRouter also requires an explicit endpoint, with no automatic fallback.
   Settings are saved in project configuration.
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
/image-model openrouter <model-id> <endpoint-tag>
```

`/model` still selects the conversation model. `/image <path>` still previews a
TUI-local file, including when the runtime is remote. `/image-model builtin`
follows your OpenAI conversation authentication: Codex OAuth uses the dedicated
Codex image backend with existing token refresh and defaults to `gpt-image-2`;
API-key authentication uses the public Image API. Neither changes your chat model
or silently switches auth/account/billing routes. Codex Sunburst/Flare execution
is not yet live-verified; explicit selections are never replaced with another model.

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
unknown provider options are rejected. There is no separate image-key entry UI
or stored OAuth/API-key coexistence migration yet.

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
ports are accepted; redirects, credentials and private network addresses are
rejected. Do not include secrets in URL query strings. Local paths refer to the
runtime host, including SSH, and retain normal sandbox restrictions.
URL downloads require a direct connection. When Bun has proxy environment variables
configured, use local file/artifact references instead; the runtime rejects URL
acquisition rather than bypassing destination checks through a proxy.

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

- One PNG per request, at most 8 MiB, 4096 pixels per side and 16 megapixels;
  noninterlaced 8-bit PNG only. OpenRouter models that return other formats are
  not supported: a non-PNG default is rejected, potentially after a charge.
- Reference count: up to 16 for the public OpenAI route, 5 for Codex, and the
  selected endpoint's supported count for OpenRouter (Codelia ceiling 16).
  PNG/JPEG/WebP references are limited to 8 MiB each, 32 MiB combined, 4096px per
  side and 16 MP; headers are validated without re-encoding. A failed source or
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
- Automated tests cover the real tools, runtime configuration/RPC, immutable
  files, history/model input and TUI transport with mocked HTTP. On September 13,
  2026, a user-approved Codex OAuth request for `gpt-image-2` also passed real
  generation, original save/reload and model-image-input restoration. The server
  did not report an effective model. Live editing and public API-key generation
  remain **UNVERIFIED**. See the gated one-request commands in the
  [implementation and verification notes](../dev-docs/specs/image-generation.md#12-implemented-codex-oauth-builtin).

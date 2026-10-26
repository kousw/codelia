# Gemini / Google native provider

Status: Planned; implementation audit and proposed scope, 2026-10-24.

## Observed implementation boundary

- `ProviderName` includes `google`; `packages/core/src/models/google.ts` contains
  old Gemini 3 preview snapshots.
- There is no `ChatGoogle`, runtime factory branch, Google auth/onboarding, or
  native TUI provider entry. These snapshots do not establish usable support.
- Named `providers` endpoints speak Responses; a Gemini URL cannot be substituted
  without a compatible protocol. OpenRouter remains its own provider and billing
  path; its discovery does not establish native Google support.

## Verified external contracts

Google recommends the generally available Interactions API for new integrations;
`generateContent` remains supported but is designated legacy. Interactions stores
requests by default, supports `store=false`, and can retain conversation state
through `previous_interaction_id`.
[Interactions overview](https://ai.google.dev/gemini-api/docs/interactions-overview).

Argon (`gemini-4-argon`, GA 2026-10-13) shares 1,048,576 tokens between input,
thinking and output. Default synchronous output is 65,536 tokens. Longer output
requires continuation/background execution. Thinking levels are low/medium/high;
explicit caching is unsupported. Images are supported as input; image generation
is a separate model capability.
[Model](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon),
[migration and long decode](https://ai.google.dev/gemini-api/docs/latest-model).

Interactions represents reasoning as ordered thought steps with opaque signatures
and optional summaries. This differs from `generateContent` part-level signatures.
An absent summary must not discard the signature or become assistant answer text.
[Thinking guide](https://ai.google.dev/gemini-api/docs/thinking).

## Proposed first implementation

This section is a recommendation, not an implemented or approved API contract.

1. Add provider-owned `ChatGoogle` using Interactions with explicit `store=false`
   and Codelia-owned history. Keep remote server state/background work opt-in for
   a later phase. Validate stateless tool replay against the current SDK first.
2. Start with Gemini Developer API key auth, retaining provider id `google`.
   Define key-env precedence without importing gcloud/Vertex/OAuth implicitly.
   Defer Vertex AI, consumer Google login, and Antigravity authentication.
3. Normalize text, thought summaries/signatures, function calls/results, terminal
   status and usage into the existing shared contracts. Preserve opaque replay
   items through persistence; define how compaction and model switches reset them.
4. Add Argon static limits and native low/medium/high mapping; canonical xhigh/max
   resolve to high with diagnostics. Reserve output inside the unified context
   budget instead of advertising independent 1M input plus 1M output limits.
5. Wire auth, onboarding, model listing, TUI, resume, and child bootstrap through
   the existing runtime factory. Model additions alone must not advertise support.
6. Initially support text/image input, function tools, bounded synchronous output,
   streaming and cancellation. Defer long-decode continuation, background jobs,
   hosted tools, video/audio/PDF and native image output to explicit later slices.

## Acceptance work before release

- Verify stateless multi-turn/tool replay with empty summaries and signatures,
  parallel tool calls, session resume, model switch and compaction.
- Verify unified budgeting, thinking-inclusive usage, cancellation, terminal/EOF
  handling, redacted provider failures and no replay after buffered delivery.
- Use official SDK/transport fixtures for mock tests; perform any paid live smoke
  only after explicit authorization. Record credential/account access separately.

Claude Sonnet 5.5/Haiku 5.5 and Gemini implementation remain separate follow-ups
from the October OpenAI/xAI/Moonshot/Z.ai model update.

# Moonshot Native Provider Spec

Status: Implemented
Date: 2026-07-17

## Goal

Provide native Moonshot API access for Kimi K3 without routing through
OpenRouter. Core owns the Chat Completions adapter; runtime owns auth, config,
model selection, onboarding, and static model listing.

## Provider contract

- Provider id: `moonshot`
- Default model: `kimi-k3`
- Base URL: `https://api.moonshot.ai/v1`
- Endpoint: `POST /chat/completions`
- Auth: `Authorization: Bearer <MOONSHOT_API_KEY>`
- Context window: 1,048,576 tokens
- Maximum `max_completion_tokens`: 1,048,576 (server default: 131,072)
- Kimi K3 always thinks and currently accepts only
  `reasoning_effort: "max"`; the K2.x `thinking` field must not be sent.
- Streaming requests set `stream_options.include_usage=true`, so the terminal
  chunk emits usage alongside `reasoning_content`, final `content`, and
  tool-call deltas. Moonshot reports cache hits as `usage.cached_tokens`.
- Vision input supports `png`, `jpeg`, `webp`, and `gif` images supplied as
  base64 `data:image/...` URLs or existing `ms://<file-id>` references. Public
  HTTP(S) image URLs are not supported.

## Core behavior

`packages/core/src/llm/moonshot/` implements `ChatMoonshot` with the OpenAI SDK
pointed at Moonshot's Chat Completions API. It:

- streams by default;
- maps shared function tools and `tool_choice`;
- preserves user image parts as a real multimodal array (never a serialized
  JSON string), accepts supported base64 and `ms://` image references, and
  rejects public/malformed image URLs before network I/O;
- converts image-bearing tool results into normal tool result messages followed
  by one deferred multimodal user message after all consecutive tool results,
  so `view_image` output reaches Kimi K3 without breaking tool-call ordering;
- accumulates reasoning, content, tool calls, and usage;
- normalizes cache hits to `input_cached_tokens`;
- emits compact Moonshot tool-call metadata;
- applies a two-hour client timeout by default, matching Moonshot's documented
  gateway timeout;
- supports `CODELIA_PROVIDER_LOG` diagnostics without logging API keys.

Moonshot requires the complete assistant response in later turns. Codelia keeps
reasoning as a separate `ReasoningMessage` for events/history, then
`toMoonshotMessages()` reattaches Moonshot-owned `reasoning_content` to the
immediately following assistant message. Reasoning from other providers is not
replayed into Moonshot requests.

## Runtime behavior

- `model.provider=moonshot`
- `MOONSHOT_API_KEY` or saved api-key auth
- optional `MOONSHOT_BASE_URL`
- `/model moonshot` and onboarding provider selection
- static `kimi-k3` model listing/details when models.dev has no Moonshot entry
- canonical reasoning levels all resolve to Kimi K3 `max`; runtime records a
  fallback when the configured level is not `max`
- `search.mode=auto` uses the local search tool; Moonshot Formula/web-search is
  not exposed as a hosted tool
- TUI `Alt+V` clipboard images arrive as inline PNG data URLs (up to three
  images per turn, 5 MiB each); `view_image` supports png/jpeg/webp/gif and
  defaults to a 5 MiB file limit

Moonshot documents a 100 MB request-body ceiling and recommends image
resolution at or below 4096x2160. Codelia's TUI/view-image defaults stay well
below the body ceiling, but the adapter does not rescale images automatically.

## Deferred

- authenticated dynamic `/models` fetching
- Formula official tools and hosted web search
- video upload/File API support
- opt-in live integration tests

## Official references

- `https://platform.kimi.ai/docs/guide/kimi-k3-quickstart`
- `https://platform.kimi.ai/docs/api/chat`
- `https://platform.kimi.ai/docs/api/list-models`
- `https://platform.kimi.ai/docs/guide/use-kimi-vision-model`

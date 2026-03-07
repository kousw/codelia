# Search Tool Spec (Native + Local Fallback)

This document defines search support for codelia with provider-native tools and
runtime local fallback.

Implementation status (as of 2026-02-17):
- Planned in this spec.
- Scope is search only.
- `image_generation` and other hosted/server tools are out of scope for this
  phase.

## 1. Goal

Provide a unified search capability with this policy:
1. Use provider-native search when available and enabled.
2. Otherwise use local fallback search.
3. Keep agent-facing behavior consistent.

## 2. Non-goals

- Enable hosted/provider tools other than search.
- Implement image generation in this phase.
- Add provider-specific non-search optimizations.

## 3. Scope

In scope:
- OpenAI native search (`web_search`)
- Anthropic native search (`web_search_20250305`)
- Runtime local fallback search tool (`ddg`, `brave`)
- Config and permission integration
- Tests and docs updates

Out of scope:
- OpenAI `web_search_preview`
- OpenRouter native search (initially disabled)
- `image_generation`

## 4. Config

Add `search` to config:

```json
{
  "version": 1,
  "search": {
    "mode": "auto",
    "native": {
      "providers": ["openai", "anthropic"]
    },
    "local": {
      "backend": "ddg",
      "brave_api_key_env": "BRAVE_SEARCH_API_KEY"
    }
  }
}
```

Rules:
- `mode=auto`: prefer native for supported providers, else local.
- `mode=native`: require native; fail if provider is unsupported.
- `mode=local`: always use local search tool.
- Defaults:
  - `mode=auto`
  - `native.providers=["openai","anthropic"]`
  - `local.backend="ddg"`
  - `local.brave_api_key_env="BRAVE_SEARCH_API_KEY"`

## 5. Runtime strategy

Per run:
1. Resolve provider and `search.mode`.
2. Decide search path:
   - native tool definition (provider side)
   - local runtime `search` tool
3. Expose only one primary path for the run to avoid tool-selection ambiguity.
4. Preserve existing session/tool logging format.

## 6. Provider mapping

OpenAI:
- hosted tool type: `web_search` (fixed in this phase)

Anthropic:
- hosted tool type: `web_search_20250305`
- tool name: `web_search`

OpenRouter:
- native search disabled in this phase; local fallback path is used.

## 7. Local fallback tool

Tool name:
- `search`

Inputs:
- `query: string` (required)
- `max_results?: number`
- `backend?: "ddg" | "brave"`
- `allowed_domains?: string[]`

Backends:
- `ddg`: keyless fallback.
- `brave`: requires API key from configured env var.

Output:
- JSON object with stable fields:
  - `query`
  - `backend`
  - `results: [{ title, url, snippet, source }]`

## 8. Permissions

Default:
- `search` is not added to system tool allowlist.
- It is `confirm` unless user allow rules are configured.

## 9. Core types and serializer behavior

Core tool definition:
- Extend `ToolDefinition` so search-hosted tool definitions can coexist with
  existing function tools.

Serializer behavior:
- OpenAI serializer maps hosted search to `web_search`.
- Anthropic serializer maps hosted search to `web_search_20250305`.
- Existing function tool serialization remains unchanged.

## 10. Error handling

- `mode=native` + unsupported provider: fail with clear message.
- `mode=auto`: choose local when native path is unavailable by policy.
- `mode=local`: no native attempt.
- Local backend errors should include actionable cause (missing key, http
  failure, parse failure).

## 11. Tests

Unit tests:
1. OpenAI serializer emits hosted `web_search`.
2. Anthropic serializer emits hosted `web_search_20250305`.
3. Existing function tool serialization remains valid.
4. Config parse/resolve for `search`.
5. Runtime strategy decision (`auto|native|local`).
6. Runtime `search` tool success/error for `ddg` and `brave`.
7. Permission defaults for new tool.

Integration tests (opt-in):
1. Native search run on OpenAI setup.
2. Native search run on Anthropic setup.
3. Local fallback run with `mode=local`.

## 12. Defaults and assumptions

- OpenAI uses `web_search` only.
- `image_generation` is out of scope for this phase.
- OpenRouter native search is disabled by default.
- Local fallback backend default is `ddg`.

# Custom Responses API connections

Register named HTTP Responses API endpoints in your global `config.json` or project `.codelia/config.json`. Select them with the TUI `/model` picker or `/model home/strata-modal`. Endpoint/model registration is file-based; the TUI supports selection and secret API-key entry, not a registration wizard.

```json
{
  "version": 1,
  "model": { "provider": "home", "name": "strata-modal", "reasoning": "medium" },
  "providers": {
    "home": {
      "type": "responses",
      "base_url": "https://llm.h.kousw.dev/v1",
      "retry": "off",
      "timeout_ms": 3600000,
      "features": { "encrypted_reasoning": true },
      "models": {
        "strata-modal": {
          "context_window": 131072,
          "supports_tools": true,
          "supports_reasoning": true,
          "supports_json_schema": true,
          "supports_vision": false,
          "reasoning_levels": ["low", "medium", "high"]
        }
      }
    }
  }
}
```

Start/restart the TUI after registering endpoints. The provider picker includes builtin providers and configured names. On first use, Codelia prompts for that endpoint's API key and stores it in its own `auth.json.providers.home` entry. Existing OpenAI API keys or OAuth are never reused. Alternatively, set `api_key_env` to the name of your endpoint-specific environment variable. Never place literal keys in config.

Use `/logout home` to remove only that endpoint's saved credentials after confirmation. Other providers' credentials remain available. If home is the current provider, its session resets; a session using another provider remains intact. `/logout` without a name clears all saved credentials and resets the current session. Logout does not revoke remote keys or unset environment variables. An endpoint configured with `api_key_env` can reuse that variable on its next authentication. Named logout requires an updated runtime; the TUI refuses to send it to older runtimes.

Provider names start with a letter and contain letters, digits, `_` or `-` (up to 64 characters). Builtin names are reserved. A project entry replaces the entire same-named global entry, including models and feature flags. Choose separate names for separately authenticated endpoints. Model IDs can contain `/`; Codelia distinguishes the endpoint name from the full backend model ID.

`base_url` is the API root, usually ending in `/v1`; Codelia appends `/responses`. Only HTTP(S) URLs without credentials, query strings or fragments are accepted. The endpoint must speak streaming Responses events. Codelia sends full history with `store:false`, ignores SSE keep-alive comments and never uses WebSockets, `previous_response_id`, `conversation`, `background` or fast-mode `service_tier`.

Model declarations are authoritative for startup, model selection, context accounting, compaction and subagents. Named endpoints do not trigger models.dev or `/models` discovery. `context_window` is required. Optional `max_input_tokens` limits the context budget; optional `max_output_tokens` declares and sends the maximum generation output, including reasoning tokens. Neither may exceed `context_window`. Omit an unverified output limit instead of guessing; very small output limits may leave no room for an answer after reasoning.

Capabilities default to false. Function tools require `supports_tools`; vision and structured output require their respective flags. Hosted tools such as native `web_search` are unavailable. Local search/function tools remain available when tools are enabled. If reasoning is enabled, supported efforts default to `low`, `medium`, `high`; override `reasoning_levels` for endpoints that support a different subset of `low|medium|high|xhigh|max`. The default effort is `medium` when available, otherwise the first declared effort. The TUI uses that model's declared effort choices and skips the reasoning picker for models without reasoning.

Optional `features` all default off:

| Field | Sent when enabled |
| --- | --- |
| `encrypted_reasoning: true` | `include: ["reasoning.encrypted_content"]` |
| `reasoning_summary: "auto"` | `reasoning.summary` (`auto`, `concise`, `detailed`) |
| `prompt_cache_key: true` | Session key as `prompt_cache_key` |
| `session_id_header: true` | Session key in the `session_id` header |
| `text_verbosity: true` | Configured `model.verbosity` as `text.verbosity` |

Only enable features your backend accepts. For Strata, keep summary, prompt cache and session headers off until independently verified. Encrypted reasoning returned in valid reasoning items is preserved through tool/result history round trips.

Automatic retry defaults to off. To opt in for an endpoint that permits POST replay, use `"retry": { "max_retries": 2, "base_delay_ms": 1000 }`. SDK retries always remain disabled; the Agent owns configured retries for failures before a successful stream starts. Stream failures are terminal. HTTP status and bounded error code are displayed without raw upstream bodies. A disconnected request may still be executing remotely; manual resubmission creates a new request.

Subagents inherit the endpoint declarations or use a configured profile/explicit named selection. They share the endpoint's auth entry and retry policy, but use their own session keys. Endpoint concurrency limiting and a cold-start elapsed-time indicator are not implemented; the backend may queue parallel requests.

The example above reflects the supplied inference-gateway contract. The local test suite verifies mock SSE, tool/reasoning replay, cancellation/error handling, compaction, model RPCs and a real delegated process against a local mock. Actual LAN access, Strata output limits, cold start and gateway POST logs still require live validation with the user's endpoint/key.

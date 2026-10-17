# Named Responses endpoints

- `ChatResponses` uses an explicitly supplied endpoint name, URL, API key and model declarations. It never inherits OpenAI auth, organization/project settings or WebSocket chains.
- Reuse the OpenAI serializers and accumulator; keep request construction allowlisted. The endpoint's configured optional features control encrypted reasoning, summary, prompt cache, session headers and verbosity.
- SDK retries stay at zero. `retryPolicy` configures Agent retries; retry off applies to parent and child calls. A successful streaming response is never automatically replayed after failure.
- Errors retain bounded status/code and safe generic messages, never raw upstream bodies. Hosted tools are rejected; local function tools remain usable.

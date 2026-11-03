# DeepSeek rules

- Use stateless HTTP Responses with full local history, no stored-response IDs, OAuth, WebSockets or service tiers.
- Keep SDK and Agent retries off; no automatic replay or endpoint/auth fallback.
- Preserve reasoning content and canonical function-call/result identity through shared Responses serialization.
- Reject unknown models, Pro image input and hosted tools before network requests.
- Reject forced named tool choice while thinking is enabled; never silently disable thinking or change the requested choice.

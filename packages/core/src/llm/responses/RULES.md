# Responses adapter rules

- Build stateless full-history HTTP requests with `store: false`. No passthrough options, stored-response references, background requests or service tier.
- Validate model capability/effort/output options before network I/O. Optional features are absent unless explicitly configured.
- Keep transport cancellation and SDK retry suppression intact; test POST counts through the Agent as well as the adapter.

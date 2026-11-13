# Decisions API

The TUI-local `decision` tool uses explicitly selected OpenAI `gpt-6-luna` or
Google `gemini-decision-1` API-key endpoints. `schema.ts` defines the common
bounded text/image and predicate/choice/score contract; `adapter.ts` maps and
validates provider-specific wire formats; `http.ts` owns bounded one-shot HTTP;
`tool.ts` enforces permissions before credentials, image reads and paid calls.
Image sources reuse immutable artifacts and the runtime's sandbox/proxy policy.
See `dev-docs/specs/decisions.md` and `packages/runtime/tests/decisions.test.ts`.

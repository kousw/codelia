# Runtime tools

Follow `../../AGENTS.md` for model-visible descriptions and schema conventions.

## Image inspection

- `view-image.ts` accepts one local `file_path` or HTTP(S) `url`. URL input only
  returns an image ContentPart for provider retrieval; it does not download,
  create artifacts, or prove that the image was accessible or visually inspected.
- `max_bytes` applies only to local files; provider limits apply to remote input.
  Moonshot does not accept public image URLs. OpenAI/Anthropic URL serialization
  has deterministic tests; live provider retrieval is a separate opt-in check.
- Local system permission must not imply remote permission. URL calls are checked
  by `../permissions/service.ts`; explicit user tool-wide allows cover both inputs.
- Tests: `bun test packages/runtime/tests/view-image-tool.test.ts
  packages/runtime/tests/permissions.test.ts packages/core/tests/image-url-serializer.test.ts`.

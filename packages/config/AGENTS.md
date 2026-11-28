# @codelia/config

Pure config schema and `ConfigRegistry` (no I/O, minimal dependencies; `version` must be `1`).

- Keep validation pure and dependency-free (`model.fast` preserves `false | true | "ultrafast"` through merges without coercing `"ultrafast"` to boolean; runtime owns capability checks).
- Whole-entry replacements (never deep-merge):
  - `image_generation` (`src/image-generation.ts`): `off|builtin|custom` whole-block override (`api_key_env` is an env variable name, never a literal secret or URL).
  - `providers` (`src/responses-provider.ts`): requires Responses base URL and positive limits; rejects builtin-name replacement, literal keys, malformed limits, and unsupported keys; replaces complete same-named endpoint maps.
  - `subagent.profiles`: replaces complete same-named profiles so options never leak across models (`max_concurrent` 1–16 merges independently; default 8 in coordinator).
- `mcp.servers` enforces `^[a-zA-Z0-9_-]{1,64}$` (invalid IDs dropped).

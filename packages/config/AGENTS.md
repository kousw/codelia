# @codelia/config

Config schema + registry (no I/O).

- `image_generation` is a strict `off|builtin|custom` whole-block override, absent
  means off. `src/image-generation.ts` validates only implemented OpenAI/OpenRouter
  options; `api_key_env` is a variable name, never a literal secret or URL. Image
  selection is independent of conversation `model`; builtin submodel selection
  lives in `provider_options.openai.model`. Do not deep-merge image blocks.

- `ConfigRegistry` registers defaults from modules and merges with loaded config.
- `config.version` is required and currently must be `1`.
- Initial schema supports `model.provider`, `model.name`, `model.reasoning`, `model.verbosity`, `model.fast`.
- Schema now includes `permissions.allow` / `permissions.deny` with tool rules and optional bash `command` / `command_glob`.
- `permissions` rule supports `skill_name` for `tool: "skill_load"` to allow/deny per skill name.
- Schema now includes `mcp.servers` (`http`/`stdio`) with project override merge by server id.
- Schema now includes `skills.enabled`, `skills.initial.*`, `skills.search.*`.
- Schema now includes `execution_environment.startup_checks.enabled|mode|commands|timeout_ms` for startup command probes.
- Server id of `mcp.servers` is valid only for `^[a-zA-Z0-9_-]{1,64}$`. Invalid ids are excluded when parsing.
- HTTP MCP server can have a refresh setting of `oauth.token_url/client_id/client_secret/scope`.
- `subagent.default_profile` and `subagent.profiles` define purpose-specific child model selections. Merge profiles by name, replacing a complete same-named profile so provider-specific options do not leak across models. No default profile is registered.
- `subagent.max_concurrent` is an optional integer 1–16, with project-over-global precedence independent of profiles. Reject invalid supplied values; the coordinator supplies the default of 8.

- `providers` declares named Responses endpoints and model capabilities/limits. Validate with `src/responses-provider.ts`; builtin names and literal keys are rejected. Merge maps by name with whole-endpoint replacement.

- `model.fast` accepts false/true/"ultrafast" in both model config and subagent
  profiles; reject other supplied values. Runtime owns model/auth capability
  checks. Config intentionally keeps this primitive schema dependency-free;
  protocol/persistence use shared-types `ModelFastMode`.

# @codelia/config

Config schema + registry (no I/O).

This package does not read files or environment variables. It only provides:
- Config types
- A registry for defaults
- Merge/resolve of loaded config layers

File I/O lives in `@codelia/config-loader`.

## Minimal config.json

```json
{
  "version": 1,
  "model": {
    "provider": "openai",
    "name": "gpt-5.2-codex",
    "reasoning": "medium",
    "verbosity": "medium"
  },
  "permissions": {
    "allow": [
      { "tool": "read" },
      { "tool": "skill_load", "skill_name": "repo-review" }
    ],
    "deny": [{ "tool": "bash", "command": "rm" }]
  }
}
```

## How it is used (runtime/CLI)

1) Modules register defaults into the shared registry.
2) CLI/runtime loads the config file.
3) CLI/runtime merges defaults + config and uses the effective values.

```ts
import { configRegistry } from "@codelia/config";
import { loadConfig } from "@codelia/config-loader";

// defaults are registered by modules (e.g. @codelia/core on import)
const config = await loadConfig("/path/to/config.json");
const effective = configRegistry.resolve([config]);
```

## Where config.json is loaded

Current behavior (runtime/CLI integration path):
- Global config + project config are both supported.
- Global config path is resolved in runtime/CLI.
- `CODELIA_CONFIG_PATH` overrides the global config file location.
- Project config is loaded from `.codelia/config.json` under the working directory.
- Effective config is resolved by merging defaults + global + project (project wins on conflicts).

See `docs/specs/storage-layout.md` for the default global path (home/XDG).

# Config write policy

Status: Implemented

This document defines where runtime writes config updates when both global and project config layers exist.

## Scope

- Global config: resolved by runtime `resolveConfigPath()`
  - `CODELIA_CONFIG_PATH` if set
  - otherwise storage default (`$XDG_CONFIG_HOME/codelia/config.json` on XDG, or home layout fallback)
- Project config: `<workingDir>/.codelia/config.json`

Read/merge behavior is unchanged: effective config is resolved from layered config.
This document only defines **write target selection** for update operations.
Sandbox mode policy (`readonly|workspace-write|full-access`) is managed separately via
global `projects.json` (see [sandbox settings and migration](specs/command-approval-and-auto-review.md#settings-and-migration)) and is out of scope here.

## Write target rules

Scope-inferred update helpers (`updateModel`, `updateTuiTheme`, `image.model.configure`) select the write target in this order:

1. **Group default write policy** decides the initial target.
2. If the key/group is already defined in one layer, use that layer as write target (sticky override).
3. Persist and emit a message that includes the actual scope/path used.

Explicit `config.set` RPC calls bypass inferred routing and write directly to the caller-specified `scope` (`global` or `project`).

### Group defaults

Group defaults are defined canonically in `packages/config/src/index.ts` as `CONFIG_GROUP_DEFAULT_WRITE_SCOPE` and cover every top-level `CodeliaConfig` group:

- `global`: `auth`, `model`, `providers`, `subagent`, `experimental`, `image_generation`, `tui`, `update`
- `project`: `permissions`, `mcp`, `agents`, `skills`, `execution_environment`, `search`

Any new top-level config group must add an entry to `CONFIG_GROUP_DEFAULT_WRITE_SCOPE` before introducing write/update APIs.

### Sticky override

If a value for the same key/group already exists in a layer, writes stay in that layer.

Examples:
- `tui.theme` default is global. If project already has `tui.theme`, update project.
- `permissions.allow` default is project. If global-only permissions management is introduced explicitly in future, it must be opt-in and documented.

## UX requirements

- Every successful update must show:
  - scope (`global` or `project`)
  - concrete file path
- Example:
  - `Saved theme 'ocean' to [global] /home/user/.config/codelia/config.json`

## Current mappings (implemented)

- `model.set` with `scope=config`: `model.*` policy (default global + sticky override)
- `model.set` with `scope=session`: no config write; stores the active session override in `SessionState.meta.codelia_model_override`
- `theme.set`: `tui.*` policy (default global + sticky override)
- `image.model.configure`: `image_generation.*` policy (default global + sticky override)
- `config.set`: writes allowlisted scalar keys directly to the caller-specified `scope` (`global` or `project`)
- Remembered built-in tool allows from confirmation prompts persist to user-owned `ProjectsPolicyStore` (`projects.json`), not shared project `config.json`; `permissions.*` config edits (such as `permissions.remove` or manual shared rules) target the `permissions` layer (`config.json`, default project)

## Rationale

- Keeps write behavior predictable without requiring users to pass scope flags.
- Preserves local intent when a project override already exists.
- Separates safety-sensitive policy settings from personal preference settings.

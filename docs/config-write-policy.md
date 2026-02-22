# Config write policy

Status: Draft (implementation-guiding)

This document defines where runtime writes config updates when both global and project config layers exist.

## Scope

- Global config: resolved by runtime `resolveConfigPath()`
  - `CODELIA_CONFIG_PATH` if set
  - otherwise storage default (`$XDG_CONFIG_HOME/codelia/config.json` on XDG, or home layout fallback)
- Project config: `<workingDir>/.codelia/config.json`

Read/merge behavior is unchanged: effective config is resolved from layered config.
This document only defines **write target selection** for update operations.
Approval mode policy (`minimal|trusted|full-access`) is managed separately via
global `projects.json` (see `docs/specs/approval-mode.md`) and is out of scope here.

## Write target rules

Runtime update paths must use the following order:

1. **Group default write policy** decides the initial target.
2. If the key/group is already defined in one layer, use that layer as write target (sticky override).
3. Persist and emit a message that includes the actual scope/path used.

### Group defaults

Group defaults are defined in `@codelia/config` as `CONFIG_GROUP_DEFAULT_WRITE_SCOPE` and must cover every top-level `CodeliaConfig` group.

Current defaults:

- `model.*` -> `global`
- `permissions.*` -> `project`
- `mcp.*` -> `project`
- `skills.*` -> `project`
- `search.*` -> `project`
- `tui.*` -> `global`

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

- `model.set`: `model.*` policy (default global + sticky override)
- `permissions` confirm/apply flow: `permissions.*` policy (default project)
- `theme.set`: `tui.*` policy (default global + sticky override)

## Rationale

- Keeps write behavior predictable without requiring users to pass scope flags.
- Preserves local intent when a project override already exists.
- Separates safety-sensitive policy settings from personal preference settings.

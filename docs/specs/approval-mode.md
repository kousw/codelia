# Approval Mode Spec

This document defines runtime approval policy modes and where they are stored.
It intentionally separates approval policy from OS-level sandbox backend isolation.

---

## 1. Goals

1. Provide explicit approval policy levels for tool execution.
2. Avoid storing safety-critical policy in project-local files that agent tools can edit.
3. Support per-project policy without requiring repository commits.
4. Keep default behavior safe when configuration is missing.

---

## 2. Non-Goals

1. Defining OS-level isolation backend details (`bwrap`/`nsjail`/container).
2. Replacing existing allow/deny rule semantics in `permissions`.
3. Solving all shell escape vectors by policy alone.

---

## 3. Modes

`approval_mode` has three values:

- `minimal`
  - Current read-oriented system allowlist.
  - Non-allowed operations require `confirm`.
- `trusted`
  - Extends system allowlist for workspace-scoped write-oriented operations.
  - Non-allowed operations still require `confirm`.
- `full-access`
  - Skip `confirm` gate and allow tool execution directly.
  - Intended for unattended workflows where operator accepts risk.

---

## 4. Source Of Truth And Precedence

Resolved in this order (highest first):

1. CLI flag: `--approval-mode <minimal|trusted|full-access>`
2. Environment variable: `CODELIA_APPROVAL_MODE`
3. Project entry in global policy store (`projects.json`)
4. Default entry in global policy store (`projects.json`)
5. Startup selection flow (first-time setup, UI-capable clients only)
6. Built-in fallback: `minimal`

Invalid values in CLI/env/policy sources are treated as explicit errors.
Resolution does not silently continue to lower priority when an invalid value is present.

---

## 5. Storage

Approval policy is stored in a dedicated global file:

- Home layout: `~/.codelia/projects.json`
- XDG layout: `$XDG_CONFIG_HOME/codelia/projects.json` (or `~/.config/codelia/projects.json`)

### 5.1 File schema

```json
{
  "version": 1,
  "default": {
    "approval_mode": "minimal"
  },
  "projects": {
    "/abs/path/to/repo": {
      "approval_mode": "trusted"
    }
  }
}
```

Rules:

- `version` is required and must be `1`.
- `default.approval_mode` is optional.
- `projects` keys are normalized absolute project roots.
- Unknown fields are ignored.

### 5.2 Write requirements

1. Create parent directory if missing.
2. Write with `0600` permission.
   - On non-Windows platforms, chmod failures are surfaced as errors (not ignored).
3. Use atomic write (temp file + rename).
4. Never write this file from model tool execution paths (`read`/`write`/`edit`/`bash`).
   - Update is only via runtime-owned settings path (startup flow and future explicit CLI command).

---

## 6. Project Key Normalization

Project key for `projects` map:

1. Resolve runtime project root from sandbox root (`runtimeSandboxRoot`) when available.
2. Otherwise use runtime working directory.
3. Normalize with `realpath`.
4. Store normalized absolute path string as key.

If normalization fails, fallback to resolved absolute path without symlink expansion.

---

## 7. Runtime Behavior

`approval_mode` affects only the pre-execution decision gate:

- `minimal` and `trusted`: existing `deny > allow > confirm` flow remains.
- `full-access`: skip `confirm` and return `allow` for non-denied tool execution.

Notes:

- Existing explicit deny rules still apply in `full-access`.
- Mode naming does not imply OS sandbox strength.

---

## 8. First-Time Setup UX

When no value is resolved from CLI/env/projects/default:

1. If UI supports selection/prompt, ask user once to choose:
   - `minimal` (recommended default)
   - `trusted`
   - `full-access`
2. Persist chosen value into `projects.json` for current project key.
3. If UI does not support interaction, default to `minimal` and continue.

This setup must not block non-interactive startup.

---

## 9. Backward Compatibility

1. Existing `permissions.allow/deny` behavior is unchanged.
2. Existing project `.codelia/config.json` remains valid.
3. `approval_mode` under project config is intentionally ignored (reserved for compatibility only if encountered).

---

## 10. Acceptance Criteria

1. Runtime resolves mode using precedence in section 4.
2. Per-project setting in `projects.json` is applied when running from subdirectories.
3. Missing config with non-interactive client falls back to `minimal` without failure.
4. Startup choice is persisted and reused on next run.
5. Project file edits cannot directly elevate mode by writing `.codelia/config.json`.

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

`approval_mode` affects the pre-execution decision gate and the runtime's logical file-path guard behavior:

- `minimal` and `trusted`: existing `deny > allow > confirm` flow remains.
- `full-access`: skip `confirm` and return `allow` for non-denied tool execution.

Notes:

- Existing explicit deny rules still apply in `full-access`.
- Mode naming does not imply OS sandbox strength.
- Runtime logical sandbox path guards for file/path tools remain active in `minimal`/`trusted`, but are bypassed in `full-access` so file arguments resolve with normal user-level path semantics.

### 7.1 Shell command analysis status

**Current behavior (implemented):**

- Permission evaluation uses a quote-aware string splitter in
  `packages/runtime/src/permissions/utils.ts` and evaluates the resulting command
  segments against allow/deny rules.
- The splitter recognizes a limited set of separators, pipes, and redirects. It is
  not a shell grammar parser and does not model substitutions, loops, conditionals,
  functions, subshells, or dialect-specific syntax.
- Unix execution uses the configured shell (`$SHELL -lc`) when available. Windows
  falls back to the platform shell selected by Node/Bun `shell: true`; PowerShell is
  not currently a first-class execution dialect.
- Consequently, `minimal` and `trusted` are approval policies, not proof that an
  allowed shell string is side-effect free. AUD-002 tracks the resulting prefix-rule
  escape risk.

### 7.2 Planned parser-backed boundary

**Planned; not yet implemented:** replace permission-time shell string splitting
with a dialect-aware analysis boundary. This change improves the correctness of the
approval decision; it does not attempt to provide OS-level process isolation or make
an explicitly approved script safe.

The runtime should expose a parser-independent DTO to permission, remember, preview,
and UI code:

```ts
type ShellAnalysis = {
  dialect: "posix" | "powershell" | "cmd" | "unknown";
  kind: "simple" | "pipeline" | "compound" | "unsupported";
  commands: Array<{
    name: string | null;
    args: string[];
  }>;
  features: Array<
    | "redirect"
    | "command-substitution"
    | "process-substitution"
    | "subshell"
    | "loop"
    | "conditional"
    | "function"
    | "dynamic-word"
  >;
  autoApprovalEligible: boolean;
  parseError?: string;
};
```

Parser-specific AST nodes must not escape the adapter. A `ShellDialectAdapter`
produces `ShellAnalysis`; the existing permission service consumes only that DTO.
This keeps parser/library replacement separate from policy behavior.

Planned adapters:

- POSIX-family shell: first evaluate
  [`sh-syntax`](https://github.com/un-ts/sh-syntax), a WASM wrapper around
  [`mvdan/sh`](https://github.com/mvdan/sh). Before adoption, verify Bun loading,
  `tsup` ESM/CJS output, npm package contents, and release smoke behavior on all
  supported platforms.
- PowerShell: use a separate adapter based on the official
  [`System.Management.Automation.Language.Parser`](https://learn.microsoft.com/dotnet/api/system.management.automation.language.parser.parseinput)
  only when that runtime is explicitly available. Do not pass PowerShell text
  through a POSIX parser.
- `cmd.exe` and any unavailable/unknown dialect: initially produce `unsupported`
  and require confirmation in `minimal`/`trusted`.

The parser adapter is an analysis dependency only. It must never evaluate, expand,
source, or execute the command being inspected.

### 7.3 Planned decision rules

In `minimal` and `trusted`:

1. Parser failure, unsupported dialect, or ambiguous/dynamic syntax requires one
   confirmation for the original command string.
2. Substitution, redirection, process substitution, subshells, loops, conditionals,
   and function definitions are not eligible for prefix-based automatic approval.
3. Simple commands may use the existing allow/deny policy after successful static
   analysis. Pipelines may be auto-approved only when every parsed command is simple
   and individually allowed and no disqualifying feature is present.
4. Deny rules inspect every statically identified nested command. A nested deny takes
   precedence over an outer allow.
5. Compound commands are displayed and confirmed once as the original command. Shell
   grammar keywords such as `for`, `do`, and `done` are not presented as executable
   commands.
6. Remember candidates are generated only for eligible simple commands. A compound,
   dynamic, failed, or unsupported analysis does not generate per-child remember
   rules.
7. A future exact-full-command rule may explicitly allow otherwise ineligible syntax.
   Prefix and glob rules must not be treated as exact authorization.

`full-access` continues to bypass confirmation as defined above, while explicit deny
rules remain applicable. Shell analysis is not a replacement for a future sandbox
backend: an approved `bash script.sh`, `pwsh -File script.ps1`, or equivalent
interpreter invocation executes with the privileges of the runtime process.

### 7.4 Planned implementation sequence

1. Add characterization tests for current allow/deny/remember behavior and exploit
   regressions from AUD-002.
2. Run a dependency spike for the POSIX parser, including representative Bash/Zsh
   syntax and packaged WASM resolution.
3. Introduce `ShellAnalysis` and the POSIX adapter without exposing library AST types
   outside the adapter.
4. Route approval, deny, remember, and preview rendering through the shared analysis.
5. Treat PowerShell, `cmd.exe`, and unknown dialects as confirmation-only until their
   own adapter has equivalent tests.
6. Add PowerShell analysis separately; keep execution-shell selection and permission
   parsing aligned through an explicit dialect value.

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

The parser-backed shell rules in sections 7.2-7.4 are future acceptance criteria and
are not part of the currently implemented approval-mode acceptance set.

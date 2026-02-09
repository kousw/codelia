# Permissions Spec

This document defines the specifications for permission judgment, UI confirm linkage, and configuration files when running the tool.
In the initial implementation, it is determined on the Runtime side, and Core does not depend on the UI.

---

## 1. Goals / Non-Goals

Goals:
- Always check permission before running tool
- Default is **confirm** (UI confirmation)
- Skip confirm only if match with allowlist
- **deny** if UI confirm is not supported
- bash examines command contents (supports subcommands)

Non-Goals:
- Accurate determination of "execution type" such as network access
- OS level enforcement (this is the responsibility of sandbox)

---

## 2. Terminology

- **Permission decision**: One of `allow | deny | confirm`
- **Rule**: allow / deny conditions for tool / bash command
- **System allowlist**: Default allowlist built into Runtime

---

## 3. Config Schema (`config.json`)

Add `permissions` to `@codelia/config`.

```json
{
  "version": 1,
  "permissions": {
    "allow": [
      { "tool": "read" },
      { "tool": "bash", "command": "rg" },
      { "tool": "bash", "command_glob": "git status*" }
    ],
    "deny": [
      { "tool": "bash", "command": "rm" }
    ]
  }
}
```

### 3.1 Type definition

```ts
type PermissionRule = {
  tool: string;
command?: string; // First 1-2 words of bash (subcommand)
command_glob?: string; // bash full text glob
skill_name?: string; // skill name of skill_load (exact match)
};

type PermissionsConfig = {
  allow?: PermissionRule[];
  deny?: PermissionRule[];
};
```

### 3.2 Interpretation of rules

- `tool` is **required**.
- `command` / `command_glob` are **bash only**.
- `skill_name` is **skill_load only**.
- **AND** if both `command` and `command_glob` are specified.
- Matches the entire tool if `command` / `command_glob` is not specified.
- `tool: "skill_load"` with `skill_name` matches only the specified skill.

---

## 4. Config reading range

Evaluate by **combining** multiple layers (arrays are concatenated).

Priority order (**concatenation**, not last win):
1. System allowlist (built in Runtime)
2. Global config（`CODELIA_CONFIG_PATH` or default）
3. Project config（`.codelia/config.json`）

---

## 5. Rating order

Judgment is made in the following order:

1. Matches `deny` → **deny**
2. Matches `allow` → **allow**
3. Other → **confirm**

If UI confirm is unavailable, `confirm` is treated as **deny**.

---

## 6. bash special treatment

### 6.1 Normalization

Normalize bash's `command` input before evaluation:
- beginning/end trim
- Collapse consecutive spaces into one

### 6.2 Interpretation of `command` (Supports subcommands)

`command` is determined by **matching the first 1 or 2 words**.

- If the rule is one word, **Match first word**
- If the rule is 2 words, **Match first 2 words**

example:
- Matches `command: "git"` → `git status`, `git push origin main`
- Matches `command: "git push"` → `git push origin main`

### 6.3 Interpretation of `command_glob`

`command_glob` glob matches **normalized full text**.

- `*` is any string
- `?` is any single character
- Everything else is a literal match

example:
- `rg*` → `rg -n foo`, `rg    -S bar`
- `git push*` → `git push origin main`

> Don't use regular expressions. glob only supports `*` and `?`.

### 6.4 Split and evaluate (pipe/concatenation/redirect operators)

Divide the command using the following **operators** and judge.

- Split targets: `|`, `||`, `&&`, `;`, `>`, `>>`, `<`, `2>`, `2>>`, `|&`
- **Ignore operators inside quotes (`'...'` / `"..."`) or escaped with backslashes**
- Consecutive operators are interpreted as **longest match** (e.g. `|&` is `|&` instead of `|` + `&`)

Judgment rules:

- Divide the normalized command by operator
- Perform permission judgment for each divided segment**
- **Automatically allowed only when all segments are allow**
- If at least one cannot be allowed, confirm

supplement:

- The **right side of redirection (e.g. `/dev/null` and output destination file) is not treated as a command**
- `command` Only the command on the left is judged
- However, **If you want to automatically allow commands that include redirects**
Explicitly allow full text matching with `command_glob` (e.g. `"rg* > /dev/null"`)
- `command_glob` applies not only to the **post-split segment** but also to the normalized **full text**
- If the full text matches, you can immediately decide to allow/deny.

> Apply `command` / `command_glob` to the segment string after division, and apply `command_glob` to the entire text.

---

## 7. System allowlist

### 7.1 Tool allowlist

The following is **allow** by default:
- `read`
- `grep`
- `glob_search`
- `todo_read`
- `todo_write`
- `tool_output_cache`
- `tool_output_cache_grep`
- `agents_resolve`
- `skill_search`
- `skill_load`
- `done`

### 7.2 bash allowlist (min read)

The following allows **command**:
- `pwd`
- `ls`
- `rg`
- `grep`
- `find`
- `sort`
- `cat`
- `head`
- `tail`
- `wc`
- `stat`
- `file`
- `uname`
- `whoami`
- `date`
- `git status`
- `git diff`
- `git show`
- `git log`
- `git rev-parse`
- `git ls-files`
- `git grep`

`cd` is not a command allowlist and is automatically allowed by runtime only if there is no deviation from the sandbox.
Confirm `cd` to exit the sandbox.

---

## 8. UI confirm

Use `ui.confirm.request` when determining `confirm`:

- title: `Run tool?` / `Run command?` etc.
- message: tool name + main input (command string for bash)
- bash message uses **normalized command** (6.1)
- danger_level: `danger` can be used (danger commands, etc.)

**deny** if the UI is `supports_confirm=false`.
The UI can optionally include the following in `UiConfirmResult`:
- If `remember: true`, skip confirm and allow from next time
- Add runtime to in-memory allowlist and persist in project config (`.codelia/config.json`)
- bash storage granularity:
- Commands are broken down into segments and saved using the 6.4 splitting rules.
- Save each segment as `command` (first 1 word, first 2 words for subcommand types)
- `cd` is not persisted due to dynamic determination
- If `reason: string`, return to tool as deny reason

---

## 9. Error expression

When rejected, return the tool as an error:

- `ToolMessage.is_error = true`
- `content = "Permission denied: <reason>"`

---

## 10. Examples

### 10.1 All confirm (no allow)

```json
{ "version": 1, "permissions": { "allow": [], "deny": [] } }
```

### 10.2 Allow only bash

```json
{
  "version": 1,
  "permissions": {
    "allow": [
      { "tool": "bash", "command": "rg" },
      { "tool": "bash", "command_glob": "git status*" }
    ]
  }
}
```

### 10.3 deny priority

```json
{
  "version": 1,
  "permissions": {
    "allow": [ { "tool": "bash", "command": "rm" } ],
    "deny":  [ { "tool": "bash", "command": "rm" } ]
  }
}
```

### 10.4 Control skill_load by skill name

```json
{
  "version": 1,
  "permissions": {
    "allow": [{ "tool": "skill_load", "skill_name": "repo-review" }],
    "deny": [{ "tool": "skill_load", "skill_name": "dangerous-skill" }]
  }
}
```

→ `deny` takes precedence and `skill_load` of `dangerous-skill` is rejected.

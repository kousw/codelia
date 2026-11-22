# Storage Layout Spec

This document defines the on-disk layout for Codelia local data.

## 1. Goals

- Provide a single place for local config, cache, sessions, and logs.
- Keep defaults simple (`~/.codelia`) while allowing XDG layout opt-in.
- Store user-visible formats as JSON / JSONL / plain text.

## 2. Layouts

### 2.1 Home layout (default)

Root: `~/.codelia/`

```
~/.codelia/
  config.json
  projects.json
  credentials/               # 0700 (POSIX) / owner-only DACL (Windows), protected from confined shells & file tools
    auth.json                # provider auth v2 (when file backend is active)
    mcp-auth.json            # MCP OAuth v2 with endpoint binding (when file backend is active)
    storage-state.json       # non-secret backend ownership & migration state
    .auth-store-lock.sqlite  # interprocess SQLite lock for auth & mcp-auth
  cache/
    tool-output/
  sessions/
    messages/  # append-only originals
    contexts/  # active resume checkpoints
    state/
    state.db
  logs/
```

### 2.2 XDG layout (opt-in)

Enable with `CODELIA_LAYOUT=xdg`.

- Config: `$XDG_CONFIG_HOME/codelia/` (or `~/.config/codelia/`)
- Cache: `$XDG_CACHE_HOME/codelia/` (or `~/.cache/codelia/`)
- State: `$XDG_STATE_HOME/codelia/` (or `~/.local/state/codelia/`)

```
$XDG_CONFIG_HOME/codelia/config.json
$XDG_CONFIG_HOME/codelia/projects.json
$XDG_CONFIG_HOME/codelia/credentials/auth.json
$XDG_CONFIG_HOME/codelia/credentials/mcp-auth.json
$XDG_CONFIG_HOME/codelia/credentials/storage-state.json
$XDG_CONFIG_HOME/codelia/credentials/.auth-store-lock.sqlite
$XDG_CACHE_HOME/codelia/
$XDG_CACHE_HOME/codelia/tool-output/
$XDG_STATE_HOME/codelia/sessions/
$XDG_STATE_HOME/codelia/sessions/messages/
$XDG_STATE_HOME/codelia/sessions/contexts/
$XDG_STATE_HOME/codelia/sessions/state/
$XDG_STATE_HOME/codelia/sessions/state.db
$XDG_STATE_HOME/codelia/logs/
```

## 3. File formats

- `config.json`: JSON with a `version` field.
- `projects.json`: user-owned sandbox modes, protected paths, and per-workspace `trust_project_allows` overrides. The standard local runtime accepts stored legacy `approval_mode: "trusted"` at its original scope. See [command approval](./command-approval-and-auto-review.md).
- `credentials/auth.json`: provider auth v2 JSON (`0600` on POSIX) when the file backend is active. On macOS with Keychain active (`auth.storage: "auto"` or `"keyring"`), credentials are stored in macOS Keychain under service `codelia.auth` instead of on disk. Legacy root-level `auth.json` is auto-migrated under the two-phase protocol in `dev-docs/specs/auth.md` §9.
- `credentials/mcp-auth.json`: MCP OAuth v2 JSON (`0600` on POSIX, bound to canonical `resource_uri`/`issuer`/`token_endpoint`/`client_id`) when the file backend is active, or macOS Keychain service `codelia.mcp-auth` when Keychain is active. Legacy root-level `mcp-auth.json` is auto-migrated (unbound v1 entries are dropped with a re-auth notice).
- `credentials/storage-state.json`: non-secret backend ownership / write-ahead migration marker (`steady` / `migrating`).
- `credentials/.auth-store-lock.sqlite`: owner-verified SQLite `BEGIN IMMEDIATE` interprocess lock shared by `auth` and `mcp-auth`.
- `sessions/YYYY/MM/DD/<run_id>.jsonl`: run event log (one event per line).
- `sessions/state.db`: SQLite index for session resume metadata and the
  per-session run-log index (`session_runs`, `session_run_checks`, `session_run_rescans`, `storage_meta`;
  see `session-store.md` §2.1).
- `sessions/messages/<session_id>.jsonl`: append-only original messages (one serialized `BaseMessage` per line).
- `sessions/contexts/<session_id>.json`: current active messages and covered original byte boundary for resume.
- `sessions/state/<session_id>.json`: legacy session snapshot format kept for backward compatibility reads.
- `sessions/diagnostics/YYYY/MM/DD/<run_id>.jsonl`: opt-in full dumps (`CODELIA_SESSION_DUMP=1`).
- `<storage-root>/usage/YYYY/MM/DD/<run_id>.jsonl`: compact usage retained independently of run logs.
- `sessions/active-runs/<session-hash>/<run_id>.json`: PID-owned live-writer protection.
- `cache/tool-output/`: tool output cache (storage area for redeploying with reference ID)
- `logs/`: plain text logs.

### 3.1 config.json (initial)

Precedence (highest first):
1. CLI arguments
2. Environment variables (if supported)
3. `config.json`
4. Defaults

Initial schema (minimum):
```json
{
  "version": 1,
  "model": {
    "provider": "openai",
    "name": "gpt-4.1-mini",
    "reasoning": "medium"
  }
}
```

Notes:
- `model.reasoning` is a provider-specific hint (e.g. "low" | "medium" | "high").
- Project-level config lives at `.codelia/config.json` and is loaded by runtime (`@codelia/cli` uses this through runtime startup).
- `CODELIA_CONFIG_PATH` can override the global config file location.
- `projects.json` stores global per-project policy settings (see [sandbox settings and migration](./command-approval-and-auto-review.md#settings-and-migration)).
- Defaults live in code and are registered by modules into a config registry used by CLI/runtime.

## 4. Windows

Windows uses the home directory layout by default (e.g. `C:\Users\<User>\.codelia`).

## 5. Implementation notes

- Storage path resolution lives in `@codelia/storage`.
- Consumers should create directories on demand; missing paths are not fatal.
- Run-log maintenance compresses normal events after 30 days or archive for
  unpinned sessions after removing diagnostic snapshots, including from legacy gzip.
  Explicit diagnostic dumps may expire. See `conversation-archive.md`.
  Originals, active contexts, indexes, references, tasks and usage are preserved.

### Delegated task metadata (implemented MVP, 2026-09-05)

The version-1 task registry optionally stores `subagent` lineage (tree/node/
parent/session/depth/spawn index, effective policy id and workspace lease id),
`executor_identity`, and result `termination_reason`, cumulative `usage`, and
`summary_cache_id`. Optional additions preserve old shell records. Retained
lineage records form the current lifetime spawn ledger; do not garbage collect
without preserving counters/usage. A child session uses a fresh session id and
`meta.codelia_subagent`; child event logs are separate from the parent run.

### Subagent mailbox records

Task records may contain `messages: AgentMessage[]` with stable message_id,
sender, recipient, created_at and content, plus optional runtime-derived
sender_name/recipient_name. Subagent lineage stores an immutable human `name`;
legacy nameless records remain readable. Runtime authenticates session scope
and persists before send acknowledgement. Each record is capped at 256 messages
and 1 MiB; bodies are capped at 8 KiB. Delivery cursors are runtime-local, so
restart may replay persisted messages with the same ids. Task cleanup must retain
spawn accounting and unread mailbox data; no automatic mailbox GC is implemented.

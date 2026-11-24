# Sandbox HOME, Git metadata and PTY: Codex and Claude Code

Comparison input for confined local Git writes, the confined HOME and PTY
allocation. Only first-party public source was used, pinned to:

- Codex: `openai/codex` at `177c406276b6757ffaf49da9de52cd7a64c97dd5`
- Claude Code sandbox: `anthropic-experimental/sandbox-runtime` at
  `0bbebed0aa9a8e628dc4df8bc30293550a1988eb`

## Summary

| Topic | Codex | Claude Code (sandbox-runtime) | Codelia today |
| --- | --- | --- | --- |
| Child HOME | Real HOME; environment inherited by default (`ShellEnvironmentPolicy` default `inherit = all`, default `*KEY*`/`*SECRET*`/`*TOKEN*` excludes ignored by default) | Real HOME; child inherits `process.env` under `sandbox-exec`/`bwrap` | Scratch HOME, minimal environment |
| Home writes | Not writable unless configured | Not writable except `~/.npm/_logs`, `~/.claude/debug` | Not writable (scratch HOME absorbs writes) |
| `.git` in workspace | Read-only project subpath (`.git`, `.agents`, `.codex`) | Writable except `.git/hooks/**` and `.git/config` (also nested `**/.git/...`); `allowGitConfig` opt-in | Read-only (Git dir, common dir, marker) |
| Git env injection | — | `GIT_CONFIG_COUNT`/`KEY`/`VALUE` for `safe.directory` | `GIT_OPTIONAL_LOCKS=0` |
| History-destroying Git commands | No Git-specific rule (dangerous-command check covers forced `rm`, `sudo` wrappers) | No Git-specific rule | Generic action words (`reset`, `clean`, `prune`, `delete`, `remove`) |
| Absent deny paths on Linux | `.git` read-only | Mounts `/dev/null` at the first missing component to block creation | `.git` read-only |
| PTY (macOS) | `(allow pseudo-tty)`, `/dev/ptmx`; read/write on `/dev/ttys[0-9]+` only with the `com.apple.sandbox.pty` extension (PTYs created inside the sandbox); ioctl only on pre-existing ttys | Opt-in `allowPty`: `pseudo-tty`, `/dev/ptmx` and all `/dev/ttys*` | `/dev` denied except null/zero/random/urandom |

## Findings that change Codelia's plan

1. **The scratch HOME is the outlier.** Both peers keep the real HOME and
   restrict writes. Git identity, `~` expansion (`core.excludesFile`,
   `includeIf "gitdir:~/..."`) and tool configuration then work without
   per-tool workarounds. Codelia's `GIT_CONFIG_GLOBAL` / excludes injection
   plan only exists because of the scratch HOME.
2. **Git write scope.** Claude Code protects only hooks and config. It does
   not protect pointer files such as `commondir`, `objects/info/alternates`
   or legacy `remotes/`, which can redirect a later unsandboxed Git command.
   Codelia's broader deny list is cheap on Seatbelt (static path denies).
3. **History protection.** Neither peer adds Git-specific destructive
   classification. Codex keeps history safe by keeping `.git` read-only;
   Claude Code accepts that ref changes are possible inside the sandbox.
4. **PTY.** Codex's rule allows PTYs created inside the sandbox without
   read/write access to the user's other terminals; Claude Code's opt-in rule
   is broader.

Source locations (pinned revisions above):

- Codex: `codex-rs/sandboxing/src/seatbelt_base_policy.sbpl` (PTY),
  `codex-rs/protocol/src/permissions.rs` (protected `.git`/`.agents`/`.codex`),
  `codex-rs/protocol/src/shell_environment.rs` and `config_types.rs`
  (environment policy), `codex-rs/shell-command/src/command_safety/is_dangerous_command.rs`.
- sandbox-runtime: `src/sandbox/sandbox-utils.ts` (`DANGEROUS_FILES`,
  `getDangerousDirectories`, `HOME_CONVENIENCE_WRITE_DIRS`, `buildGitConfigEnv`),
  `src/sandbox/macos-sandbox-utils.ts` (`macGetMandatoryDenyEntries`, PTY),
  `src/sandbox/linux-sandbox-utils.ts` (absent deny paths).

## What Codelia adopted

- Real HOME with writes still restricted, as both peers do; private
  `TMPDIR` / `XDG_CACHE_HOME` remain.
- Claude Code's model for local Git writes, with Codelia's broader protected
  list (pointer files and legacy remotes in addition to hooks and config).
- No Git-specific destructive classification, as in both peers.
- Codex's PTY rule on macOS.
- Linux: protected names that do not exist cannot be reserved with bind mounts
  without creating files in the repository, so the launcher removes any it
  finds after the launch exits.


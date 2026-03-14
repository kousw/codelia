# Startup Execution Environment Metadata Spec

Status: `Implemented` (2026-03-14)

This spec defines a small, stable execution-environment summary that runtime injects into the agent's startup context so the agent can choose shell syntax and execution strategy more reliably.

---

## 0. Motivation

The agent needs a few stable facts at session start:

- what shell implementation the `shell` tool uses,
- whether bash-specific syntax is safe to assume,
- what workspace/sandbox root it is operating in,
- what major runtime tools are available.

Today that information is either implicit or scattered across implementation details. Making it explicit improves tool selection and reduces shell syntax mistakes.

---

## 1. Goals

- Provide a concise startup snapshot of execution environment facts that materially affect agent decisions.
- Prefer stable fields that rarely change during one runtime session.
- Keep the injected payload small enough to live in the default system/startup context.
- Avoid dumping the full process environment or large mutable state.

## 2. Non-goals

- Streaming live environment changes into the prompt on every turn.
- Exposing the full `env` map, `PATH`, shell rc contents, aliases, or arbitrary host secrets.
- Replacing normal runtime/tool inspection when the agent needs precise live state.

---

## 3. Startup block

Runtime injects a short structured block near startup context.

Current format: outer `<execution_environment>` tag with plain-text labeled lines so the block stays easy for both models and humans to scan.

```text
<execution_environment>
os: Linux 6.8.0-79-generic (linux x64)
shell tool: shell
shell execution: /bin/zsh -lc
bash syntax guaranteed: false
sandbox root: /repo
working directory: /repo

startup checks:
- "rg --version" => ripgrep 14.1.1
</execution_environment>
```

The block is still intentionally small and prompt-safe; the startup checks are bounded one-line command results, not a full environment dump.

---

## 4. Field guidance

### Required core fields

- `os` (include a little more detail than just `linux`/`darwin`; for example type + release + arch)
- `shell tool`
- `shell execution`
- `bash syntax guaranteed`
- `sandbox root`
- `working directory`

### Optional fields

- `startup checks` (bounded one-line results of cheap commands that help the agent choose the right executable name)
- `notes` for short compatibility hints
- `workspace write mode` if future task/worktree execution changes the default safety model

### Startup check guidance

- The default startup checks are enabled.
- The default command list is intentionally minimal: `rg --version`.
- Checks run once at startup, concurrently, with a 10000ms default timeout per command.
- Checks are configurable via `execution_environment.startup_checks`:
  - `enabled: false` disables them,
  - `mode: append|replace` controls whether custom commands extend or replace the defaults,
  - `commands` is an argv-array list such as `[["python3", "--version"], ["uv", "--version"]]`,
  - `timeout_ms` overrides the per-command timeout.
- Startup checks should stay read-only and cheap; they are for command-selection hints, not for broad host introspection.

### Excluded fields

Do not inject by default:

- full environment variables,
- full `PATH`,
- command aliases/functions from rc files,
- transient per-turn process state,
- large package inventories.

---

## 5. Refresh policy

This startup block is a session-scoped snapshot.

Rules:

1. Compute it once when the runtime/agent session starts.
2. Recompute it when a new runtime session starts.
3. Recompute it when a material execution-environment change is known to have happened before the next run starts.
4. Do not try to keep the prompt perfectly synchronized with every host-side mutation during a live session.

Rationale:

- Shell implementation and OS rarely change during one runtime session.
- The agent only needs a reliable default model, not a live mirror of the host.
- If exact live details matter later, the agent can still inspect them using tools.
- The rendered block is exposed via `context.inspect.execution_environment`, and `CODELIA_DEBUG=1` logs it once when the initial agent is built.

---

## 6. Stability guidance

Only include facts that are expected to be stable or low-churn within a session.

Good examples:

- shell executable/path or invocation mode,
- whether bash-specific syntax is guaranteed,
- sandbox root,
- current working directory at startup,
- command-level availability hints such as `"python3 --version" => Python 3.12.8`.

Bad examples:

- temporary files,
- active child process lists,
- current git diff summary,
- dynamic network state,
- volatile per-command shell options.

---

## 7. Relationship to tool docs

This startup metadata does not replace tool definitions.

The `shell` tool description/system prompt guidance should still state:

- what `shell` is for,
- that long-running shell work can be started in background mode,
- that shell syntax assumptions depend on the injected execution-environment metadata.

The startup block answers "what environment am I in?" while the tool description answers "how should I use this tool?".

---

## 8. Implementation status

Implemented in runtime:

- runtime-side collection of host/sandbox metadata,
- initial prompt injection before AGENTS/skills context,
- default startup command checks with config-driven disable/append/replace,
- shell execution details that match the actual agent-visible `shell` tool behavior.

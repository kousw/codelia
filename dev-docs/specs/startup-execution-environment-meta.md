# Startup Execution Environment Metadata Spec

Status: `Proposed` (2026-03-08)

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

## 3. Proposed startup block

Runtime should inject a short structured block near startup context, for example:

```text
<execution_environment>
- os: linux
- shell_tool:
  - name: shell
  - execution: /bin/sh via shell invocation
  - bash_syntax_guaranteed: false
- sandbox_root: /repo
- working_directory: /repo
- available_runtimes:
  - node: 22.x
  - bun: 1.3.x
</execution_environment>
```

The exact formatting can be XML-like, markdown, or another prompt-safe structure, but the fields should stay conceptually stable.

---

## 4. Field guidance

### Required core fields

- `os`
- `shell_tool.name`
- `shell_tool.execution`
- `shell_tool.bash_syntax_guaranteed`
- `sandbox_root`
- `working_directory`

### Optional fields

- `available_runtimes` (major toolchains only, for example Node/Bun/Python)
- `shell_tool.notes` for short compatibility hints
- `workspace_write_mode` if future task/worktree execution changes the default safety model

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

---

## 6. Stability guidance

Only include facts that are expected to be stable or low-churn within a session.

Good examples:

- shell executable/path or invocation mode,
- whether bash-specific syntax is guaranteed,
- sandbox root,
- current working directory at startup,
- major runtime availability.

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

## 8. Follow-up implementation notes

A later implementation pass should:

- add runtime-side collection of this snapshot,
- inject it into the initial agent context alongside AGENTS/skills context,
- ensure the values match the actual agent-visible `shell` tool behavior.

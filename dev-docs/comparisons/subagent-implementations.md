# Coding-agent subagent implementation comparison

Status: `Research snapshot` (2026-07-19)

This document records implementation evidence for the subagent architecture in
other coding agents and extracts design constraints for Codelia. It is research
input, not Codelia's normative contract. The normative contract is
[`../specs/task-orchestration.md`](../specs/task-orchestration.md).

## Scope and evidence policy

The comparison covers:

- OpenAI Codex
- Claude Code
- Gemini CLI
- Qwen Code
- OpenCode
- xAI Grok Build

Only official documentation and first-party public source repositories were
used. Source observations are pinned to the following revisions so later
upstream changes do not silently rewrite the conclusions:

| Product | Evidence revision |
| --- | --- |
| Codex | `openai/codex@0fb559f0f6e231a88ac02ea002d3ecd248e2b515` |
| Gemini CLI | `google-gemini/gemini-cli@acae7124bdd849e554eaa5e090199a0cf08cd782` |
| Qwen Code | `QwenLM/qwen-code@7b17144897bb533bd5acbcf5f9bb8df0888dc9ee` |
| OpenCode | `anomalyco/opencode@b8142c7aa8f88222873fb79d636e312e28037c2d` |
| Grok Build | `xai-org/grok-build@7cfcb20d2b50b0d18801a6c0af2e401c0e060894` |
| Claude Code | official behavior documentation; implementation is not public |

Absence of a mechanism below means that it was not found in the inspected
official surface. It does not prove that a private or newer implementation lacks
the mechanism.

## Comparison matrix

| Product | Child execution/context | Depth and fan-out | Capacity and budget | Permission boundary | Workspace boundary | Persistence/result |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | Child thread; fresh or selected parent history | configurable depth; 2026-07-19 docs defaulted to direct children only | concurrent thread cap plus a root-tree shared weighted-token budget | inherits current sandbox/approval; agent config may narrow sandbox | same environment boundary; no subagent-specific worktree contract found | shared root control plane; inspect, steer, wait, interrupt, close |
| Claude Code | fresh context by default; explicit fork inherits parent conversation | 2026-07-19 docs described non-recursive subagents | per-agent turn/time configuration; no documented tree-wide budget found | parent permission context plus per-agent modes/tools/hooks | optional temporary worktree isolation | child transcript and result return; behavior contract only |
| Gemini CLI | isolated local executor, prompt, registry, and tool loop | recursion explicitly removed from child tool registry | default 30 turns and 10 minutes per child | isolated tool allowlist and policy engine | shared workspace; tool restriction is the primary boundary | structured termination reason, activity events, session summary |
| Qwen Code | fresh named agent or full-context fork | configurable depth, default 5; schema and runtime guards | global/per-model background slots; per-agent limits | approval modes including parent-bubbling; tool allow/deny | optional worktree; documented as file isolation, not an OS sandbox | lineage/depth metadata and transcripts support background resume |
| OpenCode | child session linked by `parentID`; task id can resume it | parent-chain depth, default 1 | per-agent step limit; no tree budget or explicit active cap found | child config plus selected inherited parent denies | project/worktree path boundary; no dedicated task worktree lease found | child sessions navigable; background completion re-enters parent |
| Grok Build | independent durable child session behind a backend interface | hard maximum depth 1 in inspected source | per-agent max turns; no shared tree budget found | capability mode and child tool filtering | shared workspace or worktree | pending/active/completed coordinator, resume, transcript, task pane |

The products use different meanings for "isolation." A separate context window,
a restricted tool catalog, a git worktree, and an OS sandbox solve different
problems and must remain separate axes in Codelia.

## OpenAI Codex

As checked on 2026-07-19, official documentation exposed root-level
orchestration controls and documented `agents.max_threads=6` and
`agents.max_depth=1` as defaults. It also stated that child sessions inherit the
active sandbox and approval choices, and that a user can inspect, steer, stop,
or close child threads. See
[Codex subagents](https://developers.openai.com/codex/multi-agent).

The public implementation adds two mechanisms that are important beyond the
surface API:

1. One root-scoped `AgentControl` owns the registry, execution limiter, and
   rollout budget for the whole agent tree.
2. `RolloutBudget` accounts weighted token usage across the root-thread session
   tree instead of treating every child as an unrelated allowance.

Evidence:

- [`AgentControl`](https://github.com/openai/codex/blob/0fb559f0f6e231a88ac02ea002d3ecd248e2b515/codex-rs/core/src/agent/control.rs)
- [`RolloutBudget`](https://github.com/openai/codex/blob/0fb559f0f6e231a88ac02ea002d3ecd248e2b515/codex-rs/core/src/rollout_budget.rs)
- [thread-spawn handler](https://github.com/openai/codex/blob/0fb559f0f6e231a88ac02ea002d3ecd248e2b515/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs)

Useful for Codelia:

- Make capacity and aggregate usage root-tree resources, not fields that each
  `SubagentTaskExecutor` independently interprets.
- Reserve a slot before child startup and release it exactly once on every
  terminal/startup-failure path.
- Keep control-plane operations (`send`, `wait`, `interrupt`, `close`) separate
  from the model loop so a running child remains operable.

Do not copy blindly:

- Inheritance is convenient, but Codelia's delegated policy must be a monotonic
  intersection. A child definition or resumed session must never widen the
  parent/host boundary.

## Claude Code

Claude Code's official documentation describes a fresh isolated context as the
normal subagent mode and an explicit fork mode for sharing the parent context.
Agent definitions can select tools, disallowed tools, model, permission mode,
turn limits, skills, MCP servers, hooks, memory, background behavior, and
worktree isolation. See [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
and [worktree isolation](https://code.claude.com/docs/en/worktrees).

The documentation checked on 2026-07-19 said subagents could not spawn another
subagent. Because Claude Code is closed source and this behavior has changed
across releases, this comparison treats it as a dated public contract rather
than an implementation invariant.

Useful for Codelia:

- Model context policy explicitly as `fresh`, `fork`, or `resume`; do not infer
  it from whether a session id happens to exist.
- Keep worktree isolation opt-in and make cleanup ownership explicit.
- Treat approval routing from background work as a user-visible control-plane
  feature rather than silently blocking the child.

Do not copy blindly:

- Parent permission modes taking precedence can produce surprising effective
  permissions. Codelia should calculate and persist an immutable effective
  policy at spawn time.
- A worktree prevents file collisions but is not an OS security sandbox.

## Gemini CLI

Gemini CLI presents each named subagent as an agent tool. The official contract
specifies an independent context loop, an isolated tool selection, recursion
protection, and defaults of 30 turns and 10 minutes. See
[Gemini CLI subagents](https://geminicli.com/docs/core/subagents/).

The local executor clones isolated prompt/tool/resource registries, removes
agent tools from the child, attaches an abort/deadline, records activity, and
requires a dedicated completion tool. It returns structured termination data
rather than relying only on the child's final prose.

Evidence:

- [`LocalAgentExecutor`](https://github.com/google-gemini/gemini-cli/blob/acae7124bdd849e554eaa5e090199a0cf08cd782/packages/core/src/agents/local-executor.ts)
- [agent run types](https://github.com/google-gemini/gemini-cli/blob/acae7124bdd849e554eaa5e090199a0cf08cd782/packages/core/src/agents/types.ts)

Useful for Codelia:

- Construct the child catalog from an allowlist; never start a normal runtime
  and try to hide unsafe tools afterward.
- Require a structured child completion outcome with a termination reason,
  duration, turn count, usage, and bounded summary.
- Distinguish active execution time from time spent waiting for a human approval
  if interactive approval is added later.

## Qwen Code

Qwen Code currently supports named agents, full-context fork agents, background
execution, worktrees, and recursive subagents. Its official July 2026 update
documents a default maximum depth of 5 and two-layer protection: remove the
agent tool from the leaf schema and reject an over-depth request at runtime.
See [Qwen Code subagents](https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/),
[nested subagents](https://qwenlm.github.io/qwen-code-docs/en/blog/weekly-update-2026-07-09/),
and [fork design](https://qwenlm.github.io/qwen-code-docs/en/design/fork-subagent/fork-subagent-design/).

The public source uses an ambient agent identity/depth context, persists the
launch depth for background resume, and centralizes the reason a child may not
spawn. Its background registry reserves global/per-model slots before work
starts. Fork, teammate, and ordinary subagent modes are separate execution
concepts.

Evidence:

- [agent depth/context](https://github.com/QwenLM/qwen-code/blob/7b17144897bb533bd5acbcf5f9bb8df0888dc9ee/packages/core/src/agents/runtime/agent-context.ts)
- [background slot registry](https://github.com/QwenLM/qwen-code/blob/7b17144897bb533bd5acbcf5f9bb8df0888dc9ee/packages/core/src/agents/background-tasks.ts)
- [agent tool](https://github.com/QwenLM/qwen-code/blob/7b17144897bb533bd5acbcf5f9bb8df0888dc9ee/packages/core/src/tools/agent/agent.ts)
- [background resume](https://github.com/QwenLM/qwen-code/blob/7b17144897bb533bd5acbcf5f9bb8df0888dc9ee/packages/core/src/agents/background-agent-resume.ts)

Useful for Codelia:

- Use one pure `spawnBlockReason`-style predicate for both tool discovery and
  runtime enforcement. Hiding a tool alone is not a security boundary.
- Persist original depth and lineage. Resume, deferred approval, or context fork
  must not reset depth and regain delegation capacity.
- Distinguish total spawns, active slots, maximum depth, and per-model limits.
- Reserve capacity before persisting/launching work so rejected requests do not
  leave ghost tasks.

Do not copy blindly:

- `bubble` approval is useful interactively but cannot be the only headless
  policy. Codelia's initial child must hard-deny outside its delegated envelope.
- A worktree lease must not be described as an OS sandbox.

## OpenCode

OpenCode defines primary and subagent modes, per-agent permissions, per-agent
step limits, and child-session navigation. See
[OpenCode agents](https://opencode.ai/docs/agents).

The Task tool creates or resumes a child `Session` linked by `parentID`, walks
the parent chain to enforce `subagent_depth`, and can feed background completion
back to the parent as a synthetic prompt. In the inspected permission helper,
only selected parent restrictions are inherited before the child's own policy
is applied.

Evidence:

- [Task tool](https://github.com/anomalyco/opencode/blob/b8142c7aa8f88222873fb79d636e312e28037c2d/packages/opencode/src/tool/task.ts)
- [subagent permission composition](https://github.com/anomalyco/opencode/blob/b8142c7aa8f88222873fb79d636e312e28037c2d/packages/opencode/src/agent/subagent-permissions.ts)

Useful for Codelia:

- Make child sessions independently navigable and resumable while keeping the
  parent-child link explicit.
- Treat background/foreground as attachment state over one execution path.

Do not copy blindly:

- Inheriting only selected parent denies is not strong enough for Codelia.
  Effective permission must be `parent cap ∩ spawn envelope ∩ host cap`, with
  deny winning.
- No explicit tree-wide token budget or active execution cap was found in the
  inspected surface, so Codelia must not rely only on per-agent `steps`.

## xAI Grok Build

Grok Build exposes independent child sessions, roles/personas, capability modes,
background tasks, worktree execution, resume, transcript inspection, and a task
pane. See its [subagent user guide](https://github.com/xai-org/grok-build/blob/7cfcb20d2b50b0d18801a6c0af2e401c0e060894/crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md).

The implementation records pending work before blocking startup, uses a
`SubagentBackend` boundary, persists child session metadata, and retains
pending/active/completed entries for later query. The inspected source hard-caps
depth at one and strips the task tool from a leaf child.

Evidence:

- [coordinator/backend](https://github.com/xai-org/grok-build/blob/7cfcb20d2b50b0d18801a6c0af2e401c0e060894/crates/codegen/xai-grok-shell/src/agent/subagent/mod.rs)
- [spawn/resume flow](https://github.com/xai-org/grok-build/blob/7cfcb20d2b50b0d18801a6c0af2e401c0e060894/crates/codegen/xai-grok-shell/src/agent/subagent/handle_request.rs)
- [task depth guard](https://github.com/xai-org/grok-build/blob/7cfcb20d2b50b0d18801a6c0af2e401c0e060894/crates/codegen/xai-grok-tools/src/implementations/grok_build/task/mod.rs)

Useful for Codelia:

- Put process/channel/remote execution behind a backend or executor-factory
  contract so lifecycle logic does not depend on one transport.
- Persist pending identity before slow bootstrap, then retain terminal records
  for query and resume.
- A foreground wait timeout should detach the waiter while the task continues;
  it should not create a second execution path or imply cancellation.

Do not copy blindly:

- The inspected worktree path can fall back to the shared workspace after some
  setup failures. Codelia must fail closed when write access requires a
  worktree.
- The guide and task schema disagree about one background default in the pinned
  revision. Codelia should test its wire default rather than encode a prose-only
  assumption.

## Cross-product conclusions for Codelia

### Contracts worth adopting now

1. A root-scoped `AgentTreeCoordinator` owns lineage, capacity, shared budgets,
   and cancellation policy. `TaskManager` remains the generic task lifecycle
   substrate.
2. Every child record stores tree id, node id, parent id, original depth, spawn
   index, task id, child session id, context mode, effective policy id, and
   workspace lease id from the first release.
3. Permission is a monotonic immutable intersection:
   `host cap ∩ parent cap ∩ spawn envelope`. Deny always wins.
4. Capacity is reserved before startup and consists of separate limits:
   active slots, total spawn count, depth, per-node steps/deadline, and shared
   token/cost usage.
5. Tool availability and runtime validation use the same effective spawn guard.
6. A `WorkspaceLease` owns creation, path containment, cleanup, and preservation
   policy. Write-required worktree failure rejects the spawn.
7. Child transcript/activity is stored separately. The parent receives a
   structured, bounded, redacted result and treats child prose as untrusted
   model input.
8. Resume and fork preserve original lineage, policy, and budget ancestry. They
   never create a shallower child or a fresh allowance accidentally.

### What can remain intentionally small in Phase 3

- `max_depth=1`
- `context_mode="fresh"` only
- `workspace_mode="live_workspace"` with read-only tools only
- no shell, write, edit, client tools, or inherited MCP by default
- process-backed child runtime and separate child session
- `cancel_on_owner_exit`

Those restrictions are MVP policy, not data-model omissions. Storing the future
tree fields now avoids a registry and session migration when recursive,
resumable, or worktree-backed agents are introduced later.

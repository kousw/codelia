# Shared-workspace subagent collaboration

Status: Implemented (2026-09-05).
This user-approved revision supersedes read-only-only / mandatory-worktree rules
in task-orchestration.md. Fresh sessions and depth one remain unchanged.

## Parent delegation guidance

The shared default system prompt (`packages/core/prompts/system.md`) instructs
interactive parents to use subagents only on explicit user request or existing
permission for the current task. Once authorized, bounded delegation and messages
need no repeated confirmation of that delegation intent. Unrelated work does not
inherit it, and later user limits or revocation apply. Non-interactive parents
follow explicit task/host delegation policy; unattended execution alone grants
no permission. Tool availability remains a prerequisite.

This is model guidance, not an admission check or a new session-mode flag.
Runtime tool approval continues to apply independently. Hosts supplying their own
system prompt (including `CODELIA_SYSTEM_PROMPT_PATH`) own equivalent guidance;
the shared default does not overwrite their prompts.

## Execution and permission contract

- Default workspace_access is read-write in the same live workspace as the
  parent. Explicit read-only remains available. Worktrees are optional future
  isolation, not a prerequisite for delegation that edits files.
- Child tools: read/read_line/list_files/search_files, edit/write/shell in writable
  mode, and task_send_message/task_receive_messages/task_list for communication.
  Children cannot spawn more children, load ambient MCP/client tools, or resume.
- Omit tool_allowlist to use the full tool set for workspace_access. Read-only
  plus edit/write/shell is rejected by the shared schema before confirmation,
  with incompatible names and recovery instructions. Even search-only shell
  commands require the broader writable envelope.
- Child model calls receive the child's own session/run context, including the
  provider session key needed by OpenAI WebSocket mode. Recorded model calls and
  failure messages are redacted before retention; failure detail is bounded.
  Structured redaction operates on individual string values before JSON encoding
  so quoted credential placeholders in source files cannot corrupt serialization.
- TUI task results show the agent name, state, assignment and bounded result or
  failure detail. Failed child states use a failure marker even if task_wait itself
  succeeded. Model-visible task payloads retain lineage and routing metadata.
- TUI message tools and auto-delivered peer messages show sender/recipient names
  and bounded content previews. Sending acknowledges storage only. The runtime's
  untrusted coordination envelope remains unchanged in model history.
- Parent permission snapshot and delegated tool allowlist remain hard caps.
  Mutation/shell requests use the owning parent's permission evaluator; confirm
  decisions go through the parent's UI, never through a second child UI. Missing
  approval capability fails closed. Peer messages cannot grant permissions.
- Parent tool and child confirmation requests share one runtime queue so the TUI
  receives one active confirmation at a time. Cancelling a queued request skips
  it; cancelling an active request releases its pending response and the queue.
- task_spawn retains the normal denial contract at its shared execution gate:
  Deny without a reason stops the parent turn; a supplied reason is returned to
  the model so it can continue without admitting a child.
- edit/write require a full-content SHA-256 observed by read, or the explicit
  missing sentinel for new-file creation. Mismatch rejects the edit and directs
  the agent to reread and coordinate. Child edit/write requests execute in the
  owning parent runtime, which serializes their hash-check-through-write critical
  sections (including path aliases). Approval waits stay outside this short
  queue. No ownership lock is held across model steps. These optimistic guards
  do not serialize ordinary root tools, shell commands, external editors or other
  runtimes; coordinate those writers through messages. This is not OS isolation.
  Shell commands require the normal parent policy.
- Assignment, overlapping work, test effects and completion must be communicated.
  Shared files are live, not a snapshot. No automatic merge/rollback/commit.

## Model profiles and explicit selection

- Selection priority: explicit `task_spawn.model` or `task_spawn.profile`, then
  `subagent.default_profile`, then the parent's complete model configuration.
  `model` and `profile` are mutually exclusive. Unknown profiles fail without
  fallback. A profile's description lets the parent choose by delegated purpose.
- Config supports `subagent.profiles.<name> = { description?, model }`. Profiles
  merge by name across global/project layers; a project profile replaces the
  entire same-named profile rather than mixing settings across models.
- A selection requires `model.name` and optionally `provider`, `reasoning`,
  `verbosity`, and `fast`. Omitted provider means the parent provider. A selected
  model uses its own options/runtime defaults, not the parent's model-specific
  tuning. With no selection, all parent options remain unchanged.
- The composition root loads profile config once when initializing the parent
  and provides profile names/purposes/models in `<subagent_model_profiles>`.
  Hosts can implement optional `configProvider.resolveSubagentConfig`; disabled
  config and hosts without the method provide no profiles or configured default.
- Spawn does only local argument/profile validation, without credential probes,
  catalog lookups, or network checks. The existing child model factory receives
  the exact selection and uses normal credential loading/API execution. Supported
  provider adapters accept model ids beyond the static catalog; normal model
  aliases and provider reasoning normalization still apply. Authentication or
  execution failures return through the existing task failure path.
- User chat instructions are conveyed by the parent's model/profile tool args;
  they do not change the parent model or already running children. The runtime
  does not parse natural-language chat for model selection.

## Names and identity

- Each admitted child has an immutable agent display `name`, separate from its
  work assignment (`label` / `title`). The spawning parent must supply `name`.
  Tool guidance asks for short, distinctive code names, freely varying invented
  words and combinations rather than selecting a fixed roster or numbered sequence.
  There is no runtime name pool or automatic allocation.
- Names are trimmed, 1–48 characters, start with a letter, and allow letters,
  combining marks, digits, spaces, periods, apostrophes and hyphens. They are
  unique case-insensitively within the owning parent session, including completed
  tasks; `parent` is reserved. Admission serializes collision checking with task
  persistence; on collision the parent chooses another name.
- Names are persisted in `subagent.name` and projected as `TaskSummary.name`.
  Task lists/results, child context, approval titles and delegated shell titles
  show the name. Older records without a name remain readable.
- Messages carry runtime-derived optional `sender_name` / `recipient_name` for
  named children. The UUID sender/recipient remains authoritative; callers cannot
  supply these display-name fields. Routing continues to use exact task_id or
  the reserved parent recipient. Names do not confer permissions.

## Communication contract

- task_send_message targets an exact task_id, or parent from a child. The sender
  is supplied by the runtime, never by model arguments. Only the same parent
  session may communicate; sibling discovery is scoped task_list.
- Messages have stable ids, sender/recipient, creation time and bounded body
  (8 KiB). Persist accepted messages in the associated task record before return.
  Cap each record at 256 messages / 1 MiB; reject overflow rather than discard.
- Accepted means stored, not that the recipient model has acted. Terminal child
  recipients reject new delivery; parent inbox remains readable across turns.
- task_receive_messages supports a bounded cancellable wait, without stopping a
  child or running a nested agent turn. Reads deliver unseen messages per live
  coordinator; persisted messages may replay after restart (at least once, ids
  retained). A failed/closed IPC cannot fabricate successful delivery.
- Agent has an optional generic pollMessages callback. Apply messages as marked
  untrusted user-context envelopes before a model step and recheck before natural
  final completion. Explicit done and forced-compaction runs retain their existing
  termination behavior. Never mutate history halfway through a tool-call batch.
- Parent model tools task_wait and synchronous task_spawn return early on an unread child
  message so a parent waiting for completion can answer a child question.
- Parent idle messages wait for the next parent turn or an explicit inbox read;
  no autonomous root turn is started. Child waits/time spent receiving remain
  inside the existing deadline and iteration budget.
- Parent transport owns a small bidirectional IPC request bridge. Child tools
  call that bridge to send/receive/list, execute parent-authorized edit/write/shell operations.
  Shell tasks are registered in the parent TaskManager and cleaned up with child
  channel loss, including their process groups. Long receive waits
  must not block cancellation or other requests; close cancels pending requests.

## Verification

Mock-model tests cover real history injection and question/reply without resetting
iterations. Filesystem tests cover successful edits, stale hashes, create races,
path/symlink boundaries. Process fixtures cover simultaneous child writes using
one observed hash, bidirectional transport, pending wait cancellation and cleanup
without external provider calls. Runtime tests cover the shared confirmation
queue and Agent turn behavior after task_spawn denial with/without a reason.

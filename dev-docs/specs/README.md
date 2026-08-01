# Specification index

This directory contains maintainer-facing product and architecture contracts.
Use this index to find the canonical document and to distinguish implemented
behavior from proposals before changing code.

Last reviewed: 2026-07-19.

## Status labels

- **Implemented**: the document declares that its main contract is implemented.
- **Partial**: a meaningful subset is implemented and remaining scope is explicit.
- **Mixed**: the document intentionally contains both current and target behavior.
- **Proposed**: design/spec only; do not describe it as current behavior.
- **Experimental**: implemented behind an opt-in or unstable boundary.
- **Backlog**: deferred work inventory rather than an implementation contract.
- **Historical**: completed or dated planning material retained for context.
- **Unstated**: the document has no clear top-level status and needs reconciliation.

Status in the document itself remains authoritative. This table exposes missing or
conflicting declarations; it must not be used to promote an `Unstated` document to
implemented behavior.

## Foundations and cross-cutting architecture

| Document | Status | Purpose |
| --- | --- | --- |
| [`package-architecture.md`](./package-architecture.md) | Unstated | Target package boundaries and dependency direction |
| [`core-types.md`](./core-types.md) | Unstated | Shared Core type contracts |
| [`runtime-environment-contract.md`](./runtime-environment-contract.md) | Partial | Implemented MVP embedding boundary plus future axes |
| [`ui-protocol.md`](./ui-protocol.md) | Mixed | Implemented runtime protocol and planned extensions |
| [`storage-layout.md`](./storage-layout.md) | Unstated | Local storage layout and ownership |
| [`testing.md`](./testing.md) | Unstated | Test strategy and planned coverage |

## Agent, context, and orchestration

| Document | Status | Purpose |
| --- | --- | --- |
| [`agent-loop.md`](./agent-loop.md) | Mixed | Current agent loop and planned retry/termination behavior |
| [`agent-tasks.md`](./agent-tasks.md) | Unstated | Agent implementation task definitions |
| [`agents-hierarchy-loading.md`](./agents-hierarchy-loading.md) | Mixed | AGENTS hierarchy loading and planned events |
| [`context-management.md`](./context-management.md) | Unstated | Tool-output cache and compaction |
| [`goals.md`](./goals.md) | Proposed | Thread goals and automatic continuation |
| [`task-orchestration.md`](./task-orchestration.md) | Mixed | Implemented task/shell substrate plus proposed subagent tree and worktree contracts |
| [`lane-multiplexer.md`](./lane-multiplexer.md) | Unstated | Worktree/multiplexer lane orchestration |
| [`session-resume-semantics.md`](./session-resume-semantics.md) | Implemented | Core session resume semantics |

## Providers and models

Provider-specific transport, serialization, and error contracts live together in
[`providers/`](./providers/).

| Document | Status | Purpose |
| --- | --- | --- |
| [`providers/README.md`](./providers/README.md) | Partial | Common provider interface; six connectors implemented, Google chat planned |
| [`providers/retry-and-failures.md`](./providers/retry-and-failures.md) | Partial | Implemented common classification/retry/redaction policy plus remaining transport watchdogs |
| [`providers/openrouter.md`](./providers/openrouter.md) | Implemented | OpenRouter provider behavior with planned extensions |
| [`providers/openrouter-core-connector.md`](./providers/openrouter-core-connector.md) | Historical | Completed OpenRouter connector split |
| [`providers/openai-websocket-mode-experimental.md`](./providers/openai-websocket-mode-experimental.md) | Experimental | Opt-in OpenAI Responses WebSocket transport |
| [`providers/moonshot-provider.md`](./providers/moonshot-provider.md) | Implemented | Native Moonshot/Kimi provider |
| [`providers/xai-provider.md`](./providers/xai-provider.md) | Implemented | Native xAI/Grok provider |
| [`providers/zai-provider.md`](./providers/zai-provider.md) | Implemented | Native Z.ai/GLM provider |
| [`model-metadata.md`](./model-metadata.md) | Unstated | Model registry and models.dev metadata |
| [`model-parameter-ui.md`](./model-parameter-ui.md) | Unstated | Cross-provider reasoning parameter mapping |

## Tools, permissions, and isolation

| Document | Status | Purpose |
| --- | --- | --- |
| [`tools.md`](./tools.md) | Unstated | Tool definition, validation, DI, and serialization |
| [`edit-tool.md`](./edit-tool.md) | Mixed | Current and target edit/write guards |
| [`future-tools.md`](./future-tools.md) | Partial | Implemented and deferred built-in tool candidates |
| [`search-tool.md`](./search-tool.md) | Proposed | Native and local-fallback search policy |
| [`mcp.md`](./mcp.md) | Unstated | MCP host integration |
| [`skills.md`](./skills.md) | Partial | Implemented skills phases and follow-ups |
| [`permissions.md`](./permissions.md) | Unstated | Permission rule contract |
| [`approval-mode.md`](./approval-mode.md) | Unstated | Approval modes and storage |
| [`sandbox-isolation.md`](./sandbox-isolation.md) | Proposed | Worker isolation design and platform constraints |

## Runtime, sessions, and observability

| Document | Status | Purpose |
| --- | --- | --- |
| [`auth.md`](./auth.md) | Mixed | Implemented auth flows and planned work |
| [`session-store.md`](./session-store.md) | Unstated | Session event persistence |
| [`run-visibility.md`](./run-visibility.md) | Unstated | Run/tool progress projection |
| [`usage-tracking.md`](./usage-tracking.md) | Unstated | Usage, cost, and cache accounting |
| [`llm-call-diagnostics.md`](./llm-call-diagnostics.md) | Proposed | Per-request usage/cache/cost diagnostics |
| [`langfuse-observability.md`](./langfuse-observability.md) | Proposed | Optional Langfuse tracing |
| [`startup-execution-environment-meta.md`](./startup-execution-environment-meta.md) | Implemented | Startup environment metadata |
| [`shell-background-execution.md`](./shell-background-execution.md) | Implemented | Background shell task behavior |
| [`agentic-web.md`](./agentic-web.md) | Proposed | Durable-lite multi-instance web execution |
| [`terminal-bench.md`](./terminal-bench.md) | Partial | Core benchmark support plus deferred hardening |

## TUI

| Document | Status | Purpose |
| --- | --- | --- |
| [`tui-architecture.md`](./tui-architecture.md) | Mixed | Current TUI architecture and target refactors |
| [`tui-operation-reference.md`](./tui-operation-reference.md) | Implemented | Current user-visible TUI behavior |
| [`tui-terminal-mode.md`](./tui-terminal-mode.md) | Unstated | Inline viewport and scrollback policy |
| [`tui-render-state-machine.md`](./tui-render-state-machine.md) | Mixed | Rendering state and migration target |
| [`tui-log-component-projection.md`](./tui-log-component-projection.md) | Unstated | Log component projection design |
| [`tui-distribution.md`](./tui-distribution.md) | Mixed | Current and planned TUI packaging |
| [`tui-bang-shell-mode.md`](./tui-bang-shell-mode.md) | Partial | Implemented phase-1 bang shell mode |
| [`tui-clipboard-image-paste.md`](./tui-clipboard-image-paste.md) | Unstated | Clipboard image input behavior |
| [`tui-inline-scrollback-validation.md`](./tui-inline-scrollback-validation.md) | Implemented | Inline scrollback validation record |
| [`tui-input-queueing.md`](./tui-input-queueing.md) | Needs reconciliation | Declares Planned while the operation reference says queueing is implemented |
| [`tui-lane-command-interactive.md`](./tui-lane-command-interactive.md) | Needs reconciliation | Declares Proposed while the operation reference describes `/lane` as implemented |
| [`tui-remote-runtime-ssh.md`](./tui-remote-runtime-ssh.md) | Proposed | Remote runtime over SSH |
| [`tui-wrap-indent-continuation.md`](./tui-wrap-indent-continuation.md) | Proposed | Wrapped-line indentation |

## Desktop

The product-first desktop family is under [`desktop/`](./desktop/). These are target
contracts unless a document explicitly records implemented behavior.

| Document | Status | Purpose |
| --- | --- | --- |
| [`desktop/overview.md`](./desktop/overview.md) | Proposed | Product shape and shared principles |
| [`desktop/information-architecture.md`](./desktop/information-architecture.md) | Proposed | Main desktop regions and navigation |
| [`desktop/workspace-management.md`](./desktop/workspace-management.md) | Proposed | Workspace/session ownership |
| [`desktop/session-chat.md`](./desktop/session-chat.md) | Proposed | Conversation and run interaction |
| [`desktop/context-and-runtime.md`](./desktop/context-and-runtime.md) | Proposed | Runtime/protocol integration |
| [`desktop/file-tree-viewer.md`](./desktop/file-tree-viewer.md) | Proposed | File inspection surface |
| [`desktop/git-viewer.md`](./desktop/git-viewer.md) | Proposed | Git status/diff surface |
| [`desktop/shell-integration.md`](./desktop/shell-integration.md) | Proposed | Shell surface and context handoff |
| [`desktop/electrobun-shell.md`](./desktop/electrobun-shell.md) | Proposed | Initial Electrobun shell target |
| [`desktop/mvp.md`](./desktop/mvp.md) | Proposed | First delivery subset |
| [`desktop-gpui.md`](./desktop-gpui.md) | Partial | Separate GPUI prototype record |

## Planning and deferred work

| Document | Status | Purpose |
| --- | --- | --- |
| [`backlog.md`](./backlog.md) | Backlog | Canonical deferred work inventory |
| [`implementation-plan.md`](./implementation-plan.md) | Historical | Early implementation ordering document |
| [`packages-refactor-priorities-2026-02.md`](./packages-refactor-priorities-2026-02.md) | Historical | Completed dated package-refactor plan |

## Placement rule

- Put stable behavior and target contracts under the relevant subsystem here.
- Put temporary execution checklists in ignored `plan/`, not in this directory.
- Put operator procedures in `dev-docs/` runbooks, not in specs.
- Put audit evidence in `dev-docs/audits/`.
- Add new provider-specific documents under `dev-docs/specs/providers/` and link
  them from both this index and `providers/README.md`.

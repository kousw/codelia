# Future Tools Spec

This document records built-in tool candidates that are worth considering for
codelia after comparing the current runtime tool surface with codex and
opencode.

Implementation status (as of 2026-03-14):
- Planned/documented only.
- No runtime or protocol behavior changes are implemented by this document.

## 1. Goal

Capture a short future-facing plan for high-value tool additions so the current
gap analysis is actionable later.

## 2. Non-goals

- Replacing the current split todo tool family with a single `update_plan`-only
  interface.
- Specifying subagent/task execution in detail here.
- Turning every codex/opencode tool into a parity target.
- Locking exact JSON schema fields before implementation starts.

Task/subagent orchestration remains covered by
`dev-docs/specs/task-orchestration.md`.

## 3. Current stance

Current codelia runtime already exposes shell, file read/write/edit, local
search fallback, skills, todo mutation/read, tool output cache, lane
orchestration, and `done`.

Two design choices remain intentional for now:

- Todo tooling stays split (`todo_new` / `todo_append` / `todo_patch` /
  `todo_clear` / `todo_read`). A single whole-plan overwrite tool looks simpler,
  but in practice it increases model ambiguity around partial updates and merge
  behavior.
- Future subagent support should build on the existing task substrate rather
  than introducing an unrelated tool family. The public shape may resemble
  `task`/`spawn_agent`, but the execution model should align with codelia task
  orchestration.

## 4. Priority

Priority tiers for future tool work:

### 4.1 Priority 1

- `apply_patch`
- `request_user_input`
- `webfetch`

### 4.2 Priority 2

- `view_image`
- `lsp`
- MCP resource tools (`list_mcp_resources`,
  `list_mcp_resource_templates`, `read_mcp_resource`)

## 5. Candidate tools

### 5.1 `apply_patch`

Why:
- Multi-file edits are easier for the model to express as one atomic patch than
  as many `write`/`edit` calls.
- A codex-compatible patch grammar improves portability of prompts and learned
  behavior.

Desired shape:
- Prefer a codex-style freeform patch tool with strict patch grammar validation.
- Keep `write` and `edit` for straightforward single-file changes; `apply_patch`
  should complement them, not replace them.
- Permission previews should remain diff-oriented and match the existing
  runtime/TUI approval experience.

Open questions:
- Whether a JSON wrapper variant is needed in addition to the freeform grammar.
- Whether `apply_patch` should become the preferred edit path only for some
  models/providers.

### 5.2 `request_user_input`

Why:
- Approval prompts and normal question/clarification prompts are different
  concepts and should not share the same API surface.
- TUI can render structured questions better than relying on free-form text
  back-and-forth for short decisions.

Desired shape:
- Ask 1-3 short structured questions with labeled options and optional free-form
  answer path handled by the client.
- Keep the tool distinct from permission approval flow.
- Match collaboration mode policy explicitly (for example, whether it is allowed
  in Default mode only or also in future planning modes).

Open questions:
- Whether answers should also be persisted as structured session metadata in
  addition to normal transcript content.
- Whether the first implementation should support only multiple-choice flows.

### 5.3 `webfetch`

Why:
- `search` returns candidates, but the runtime lacks a first-class way to fetch
  and normalize a specific URL for the model.
- `webfetch` creates a natural second step after search/native search.

Desired shape:
- Fetch HTTP(S) URLs with a bounded response size and timeout.
- Support at least `markdown` and `text` outputs; `html` can remain optional.
- Integrate with existing external-access and permission policy.

Open questions:
- Whether image responses should be attached as content parts in the first
  version.
- Whether provider-native fetch/browser tools should suppress the local tool in
  some configurations.

### 5.4 `view_image`

Why:
- Local image inspection is useful for screenshot review, UI assets, diagrams,
  and visual debugging.

Desired shape:
- Accept a local file path only.
- Reuse multimodal/content-part plumbing already available for pasted image
  input where possible.
- Keep the tool lightweight and avoid turning it into a general browser/image
  editing surface.

Open questions:
- Whether non-image local files should be rejected early or delegated to normal
  file-reading tools.

### 5.5 `lsp`

Why:
- Symbol-aware navigation can reduce repeated grep/read loops for supported
  languages.
- It can improve precision for definition lookup, references, and hover-style
  inspection when an LSP client is already available.

Desired shape:
- Start with read-only navigation/query operations only.
- Fail clearly when no LSP client is active for the file type.
- Keep the first version scoped to a small set of high-signal operations.

Open questions:
- Whether codelia should expose a single multiplexed `lsp` tool or multiple
  narrow tools.
- How much LSP output should be normalized before returning it to the model.

### 5.6 MCP resource tools

Why:
- codelia already supports MCP tools, but MCP resources/templates are another
  important context channel.
- Resource access can be cheaper and more precise than web search for some MCP
  servers.

Desired shape:
- Add `list_mcp_resources`, `list_mcp_resource_templates`, and
  `read_mcp_resource`.
- Keep these as complements to MCP tool adapters rather than mixing them into
  the same tool namespace.
- Reuse existing MCP connection/auth lifecycle from runtime.

Open questions:
- Whether pagination should be exposed in the first user-visible schema.
- How aggressively resource content should be truncated or cached via tool
  output cache.

## 6. Out of scope for this document

These may still be useful later, but they are not the primary next candidates
tracked here:

- `list_dir` / directory tree helpers
- `batch` / explicit parallel tool wrapper
- `js_repl`
- artifact/presentation-generation tools
- external code-search-specific hosted tools

## 7. Suggested rollout order

1. `apply_patch`
2. `request_user_input`
3. `webfetch`
4. `view_image`
5. `lsp`
6. MCP resource tools

The first three have the clearest impact on everyday coding and research loops
without requiring major architectural expansion.

# Session Resume Semantics

Status: `Proposed` (2026-03-30)

This spec defines what `resume` means in Codelia across runtime startup context, AGENTS, skills, and restored conversation history.

---

## 0. Summary

Resume is defined as:

> restore durable conversation state, rebuild current execution context, and surface material differences before the first resumed user turn.

In short:

- conversation memory continues,
- current runtime/workspace context becomes authoritative,
- material changes from the saved session are injected as a compact resume diff instead of silently relying on stale startup context.

This spec is intentionally normative even where the current implementation still follows older history-snapshot behavior.

---

## 1. User expectation

The default user expectation for `resume` is:

1. Continue the same line of work instead of starting a new chat.
2. Operate against the current runtime launch/workspace, not a hidden reconstruction of a past machine state.
3. Avoid silent mismatches between what the model believes and what the runtime will actually execute.
4. Make important context changes visible before the first resumed turn.

Resume is therefore **memory continuity**, not **machine-state replay**.

---

## 2. Authoritative layers

When a saved session and the current runtime disagree, the following precedence applies:

1. **Current runtime state**
   - current workspace/worktree root
   - current cwd / sandbox root
   - current tool availability and tool schemas
   - current permissions / approval mode
   - current model/provider/config
   - current AGENTS / skills resolver state
2. **Current startup context injected for this runtime**
   - current `execution_environment`
   - current initial `AGENTS` context
   - current initial skills catalog
3. **Resume diff reminder**
   - compact explanation of important changes between saved and current context
4. **Restored durable conversation history**
   - prior messages, prior tool outputs, previously loaded skill bodies, and other conversational memory

Restored prompt/history content is not the source of truth for current execution conditions.

---

## 3. State classification

### 3.1 Restore as durable conversation state

The following should be restored from saved session state:

- conversation history
- prior tool outputs already shown to the model
- todo/session metadata intended to survive restart
- loaded skill bodies that were explicitly injected in prior turns
- prior AGENTS/skill/tool discussion as conversation memory

### 3.2 Rebuild from current runtime state

The following should be recomputed from the current runtime/workspace before the first resumed user turn:

- system prompt base text
- `execution_environment`
- initial `AGENTS` context for the current workspace/root
- initial skills catalog
- tool definitions / hosted tool definitions
- permissions / approval mode
- model/provider/config-bound runtime behavior

### 3.3 Surface as resume diff when changed

The following should produce a compact resume-diff reminder when materially changed since the saved session:

- workspace root / worktree root
- cwd
- sandbox root
- `execution_environment` fields relevant to tool usage
- initial AGENTS file set or AGENTS file mtimes
- skills catalog root or skill file mtimes for previously loaded skills
- tool availability changes that may affect the current thread
- permission mode / policy changes that may change what the agent can execute
- model/provider changes when they can materially change behavior

---

## 4. System prompt semantics

### 4.1 Normative behavior

On resume, the runtime should treat the **current runtime startup context** as authoritative.

That means:

- old startup-generated system context must not remain authoritative just because it was present in saved history,
- the current runtime should rebuild its system/startup context before the first resumed turn,
- any important mismatch with the saved session should be communicated via a compact resume diff.

### 4.2 Recommended implementation direction

Long term, startup-generated context should be separated from durable conversation history so resume can rebuild it deterministically.

Until that separation exists, the implementation may use a compatibility path, but the normative target remains:

- current startup context is authoritative,
- stale saved startup context is not silently trusted as current truth.

### 4.3 Why not keep the old system prompt as-is?

Keeping the saved startup/system prompt as authoritative causes hidden divergence when the current runtime differs in cwd, workspace root, AGENTS, skills, tools, or permissions. That behavior is surprising to users because the runtime executes against current reality while the model reasons from stale assumptions.

---

## 5. Resume preflight and first-turn guarantee

Before the first resumed user turn is executed, runtime should complete a **resume preflight**:

1. Load durable saved session state.
2. Rebuild current runtime startup context.
3. Compare saved vs current context for material changes.
4. Inject a compact resume-diff reminder if needed.
5. Only then accept/process the first resumed user turn.

Guarantee:

> The first resumed user turn should not depend on the model inferring current workspace/rules/tools from stale saved startup context alone.

---

## 6. AGENTS semantics on resume

### 6.1 Initial AGENTS context

The initial AGENTS context should be recomputed for the current runtime workspace/root.

The current initial AGENTS set is authoritative for future edits/tool use.

### 6.2 Previously seen AGENTS content

Previously read or discussed AGENTS content may remain in restored conversation history as memory, but it should not outrank the current initial AGENTS set.

### 6.3 Resume diff

If the applicable AGENTS file set changed, or any known AGENTS file mtime changed, the runtime should surface that change via `session.resume.diff` (or equivalent structured reminder) before the first resumed user turn.

---

## 7. Execution environment semantics on resume

### 7.1 Current snapshot wins

`execution_environment` is a startup/runtime snapshot for the current runtime session. On resume, the current runtime snapshot is authoritative.

### 7.2 Saved environment in history

A previous session's environment may still appear in restored history because it was part of startup-generated prompt context. That historical fact may remain in conversation memory, but it must not be treated as the current runtime environment.

### 7.3 Resume diff

If cwd/workspace/sandbox or other important execution-environment facts changed, the runtime should surface them in the resume diff before the first resumed turn.

---

## 8. Skills semantics on resume

### 8.1 Initial skills catalog

The initial skills catalog should be rebuilt from the current runtime/workspace.

### 8.2 Previously loaded skill bodies

Explicitly loaded skill bodies may remain in restored conversation history as durable memory.

However:

- runtime-local loaded-skill caches are not required to survive resume,
- previously loaded skill text in history does not imply the underlying skill file is still current,
- a changed or missing skill file should be surfaced as resume diff or stale-skill notice.

### 8.3 Auto-reload policy

Resume should not automatically re-inject every previously loaded skill body by default. That would increase hidden context size and make resume behavior harder to predict.

The preferred default is:

- keep prior loaded skill text as history,
- rebuild current catalog,
- warn on stale/changed loaded skills,
- explicitly reload only when needed.

---

## 9. Tooling / permissions / model semantics on resume

The runtime must execute against current runtime configuration, not saved session assumptions.

That includes:

- tool allow/deny/confirm behavior
- tool availability
- model/provider-specific runtime behavior
- current auth/MCP/search/runtime feature support

When these changes are likely to affect the current thread materially, they should be included in the resume diff.

---

## 10. Compatibility and rollout

This spec can be adopted in phases.

### Phase 1

- Keep current session restore mechanism.
- Define current runtime state as authoritative.
- Add resume-diff reminders for material changes.
- Document that saved startup context in history may be stale.

### Phase 2

- Separate startup-generated context from durable saved conversation history.
- Rebuild current startup context cleanly on resume.
- Reduce reliance on historical startup/system prompt text.

### Phase 3

- Persist just enough structured resume metadata to compute reliable diffs without scraping run logs.
- Keep logs as logs, not as the authoritative source for resume filtering or context reconstruction.

---

## 11. Non-goals

This spec does not require:

- full machine-state replay,
- reproducing past env vars/process state/installed binaries exactly,
- forcing full skill/body reload on every resume,
- keeping prompt cache hits stable across all resumes regardless of context changes.

Correctness and clear current-state semantics take priority over preserving cache compatibility with stale startup context.

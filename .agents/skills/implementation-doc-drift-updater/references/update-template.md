# Drift Review and Update Template

Use this template for implementation-vs-doc review tasks.

## 1. Drift Summary

- Scope:
  - Docs:
  - Implementation:
- Result:
  - Implemented claims:
  - Partial claims:
  - Planned claims:
  - Stale claims fixed:
  - Unknown claims:

## 2. Claim Table

| Claim ID | Doc Location | Claim | Status | Evidence | Action |
| --- | --- | --- | --- | --- | --- |
| C-01 | `docs/specs/...` | ... | Implemented / Partial / Planned / Stale / Unknown | `packages/...` | Keep / Rewrite / Split / Remove |

## 3. Rewrite Patterns

### Pattern A: Mixed present + future (split required)
- Before:
  - "The system stores messages and supports snapshot recovery with stream replay."
- After:
  - "Implemented: the system stores messages in session state."
  - "Planned: snapshot recovery with stream replay."

### Pattern B: Overclaim without evidence
- Before:
  - "Tool outputs are always idempotent."
- After:
  - "Unknown: idempotency guarantee requires maintainer confirmation."
  - or
  - "Implemented: idempotency is enforced by `tool_call_id` in ... (if verified)."

### Pattern C: Stale contract
- Before:
  - "Response output uses `output.items`."
- After:
  - "Implemented: response output uses `messages`."

## 4. Future Work Section Template

```md
## Future Work

- Planned: <feature summary>
  - Current status: not yet implemented
  - Source of intent: <spec/issue/link>
  - Implementation evidence: none (as of this update)
```

## 5. Final Checklist

- [ ] Every implemented claim has concrete evidence.
- [ ] Planned content is explicitly labeled.
- [ ] No future intent is written as present fact.
- [ ] Stale claims are rewritten or removed.
- [ ] Unknown claims are explicitly marked as unresolved.

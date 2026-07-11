# Write/Edit Content Guard and Edit Tool Spec (v2)

This document defines the enhanced behavior for the `edit` tool used by runtime/CLI.
It is compatible with the existing `edit` interface but adds safer matching,
optional diff reporting, and better disambiguation.
The `write` tool uses the same `expected_hash` contract before replacing a
complete file.

References:
- OpenCode edit tool: flexible match + diff + replaceAll + diagnostics
- Codex apply_patch tool: context-aware patch format

---

## 1. Goals

- Make edits deterministic and safe (avoid accidental multi-replace).
- Provide a diff for UI display and logging.
- Support fuzzy matching when exact text is not found.
- Keep the interface small and LLM-friendly.

---

## 2. Tool definition

```ts
export type EditToolInput = {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean; // default false
  match_mode?: "exact" | "line_trimmed" | "block_anchor" | "auto"; // default auto
  expected_replacements?: number; // optional guard
  dry_run?: boolean; // default false (return diff but do not write)
  expected_hash?: string; // optional current full-content sha256 guard
};
```

### Notes

- `old_string` may be empty. In that case the tool replaces the whole file with `new_string`.
- `expected_hash` is an optional safety guard. Omit it when a current hash is
  unavailable. If provided and the current file hash differs, the tool must
  refuse to edit.
- `write.expected_hash` follows the same optional-string contract and validates
  the complete existing content before overwriting. A provided hash cannot be
  used to create a missing file.
- Successful `read` and `read_line` text results end with
  `[read_metadata] content_sha256=<lowercase-64-hex>`. This value hashes the
  complete UTF-8 text content, independent of preview offset/truncation, and is
  accepted unchanged as `write.expected_hash` or `edit.expected_hash`.
- A provided `expected_hash` must be lowercase 64-character hexadecimal. Callers
  should copy a current `content_sha256`, explicitly compute the same full-content
  hash, or omit the field when the guard is unavailable.

---

## 3. Matching and replacement

### 3.1 Matching modes

- `exact`: raw substring match (current behavior).
- `line_trimmed`: ignore leading/trailing whitespace on each line when matching.
- `block_anchor`: match by first/last line anchors and select the best match by similarity.
- `auto`: try `exact`, then `line_trimmed`, then `block_anchor`.

### 3.2 Disambiguation

- If `replace_all=false` and multiple matches are found, return an error indicating the count.
- If `expected_replacements` is provided and the count differs, return an error.

### 3.3 Whole-file replace

If `old_string === ""`:
- Treat as whole-file replacement.
- Create the file if it does not exist.
- Return a diff showing the change.

---

## 4. Output

Return a human-readable summary plus structured metadata for UI.

```ts
export type EditToolOutput = {
  summary: string; // e.g. "Replaced 1 occurrence in src/foo.ts"
  replacements: number;
  match_mode: "exact" | "line_trimmed" | "block_anchor";
  diff?: string; // unified diff
  file_path: string;
};
```

When `dry_run=true`, the tool must not write and should set `summary` to indicate
that the output is a preview.

---

## 5. Diff format

- Unified diff with file header (`---` / `+++`).
- Line endings should be normalized (`\n`) before diffing.
- Diff is optional but recommended for UI display and audit logging.

---

## 6. Error cases

- File not found (unless whole-file replace is used).
- Path is a directory.
- `old_string === new_string` and `old_string !== ""` should be treated as no-op success
  (for idempotent retries), not an error.
- No matches found.
- Multiple matches with `replace_all=false`.
- `expected_hash` mismatch.
  The error directs callers to read the file again and retry with the new
  `content_sha256`.

---

## 7. UI integration (recommended)

If UI supports `ui.confirm` and `diff` is available:
- Runtime should send `ui.confirm.request` with the diff before applying.
- If user cancels, return a tool error and do not write.

---

## 8. Implementation hints

- Use a small set of match strategies (exact → trimmed → block anchor) to keep
  behavior predictable.
- Keep `read`, `read_line`, and `edit` on the shared UTF-8 content hash helper;
  do not normalize line endings or cache the guard value.
- Keep the old interface working; new fields are optional.
- Do not attempt LSP diagnostics in core/runtime (provider-specific).

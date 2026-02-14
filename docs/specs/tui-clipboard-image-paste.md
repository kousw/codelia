# TUI Clipboard Image Paste Spec

This document defines how the Rust TUI handles clipboard image paste and sends
image input to runtime/core.

---

## 0. Motivation

- Reduce friction for screenshot-driven debugging and UI review tasks.
- Keep keyboard-first flow in terminal (`Alt+V` paste image).
- Preserve existing text-only chat flow for non-image use.

Backlog source: `B-004` in `docs/specs/backlog.md`.

---

## 1. Scope / Non-scope

### In scope

- TUI keybinding to paste clipboard image (`Alt+V`).
- Runtime protocol support for multimodal run input.
- Passing image content to provider adapters through existing `ContentPart`.
- User-visible feedback in TUI log/status on paste success/failure.

### Out of scope (initial)

- Inline image preview rendering in TUI log.
- Drag-and-drop file/image ingestion.
- OCR preprocessing inside TUI/runtime.
- Persistent media store for pasted images.

---

## 2. Current gaps

- `run.start` input in protocol is text-only (`{ type: "text", text: string }`).
- Runtime run handler assumes `params.input.text`.
- TUI paste path currently handles text (`Event::Paste`) only.

---

## 3. UX Contract (TUI)

### 3.1 Keybinding

- `Alt+V`: try image paste from clipboard.
- If clipboard does not contain image data, fall back to current behavior
  (no mutation) and show a short status/error line.

### 3.2 Composition model

- Input keeps text as-is.
- Pasted image is inserted at the current cursor position as a system token and
  rendered in the composer as `[Image N]`.
- Multiple `Alt+V` presses before Enter can insert multiple image tokens.
- Token parsing is strict (`nonce + attachment_id`); user-typed lookalikes are
  not treated as image attachments.

### 3.3 Submit behavior

- On Enter, TUI sends one `run.start` with user text + all pending attachments.
- Message parts are built from inline token order (`text -> image -> text`).
- If the same attachment token appears more than once, only the first
  occurrence is converted to `image_url`; later occurrences remain plain text.
- After send success, clear pending attachments along with input buffer.
- On send failure, keep pending attachments for retry.

### 3.4 Cancellation/editing

- `Esc` input clear also clears pending attachments when input is non-empty.
- Optional follow-up command for explicit clear (e.g. `/clear-attachments`) is
  not required for phase 1.

---

## 4. Protocol changes

`@codelia/protocol` extends `RunInput` from text-only to a discriminated union.

```ts
export type RunInputText = { type: "text"; text: string };

export type RunInputParts = {
  type: "parts";
  parts: Array<
    | { type: "text"; text: string }
    | {
        type: "image_url";
        image_url: {
          url: string; // data URL for phase 1
          media_type?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
          detail?: "low" | "high" | "auto";
        };
      }
  >;
};

export type RunInput = RunInputText | RunInputParts;
```

Compatibility rules:

- Runtime must continue accepting `type:"text"` unchanged.
- TUI may keep sending `type:"text"` when no image is attached.
- `protocol_version` is unchanged if union is backward-compatible for readers.

---

## 5. Runtime/Core behavior

### 5.1 Runtime run input normalization

- If `input.type === "text"`: existing path (`enqueueUserMessage(string)`).
- If `input.type === "parts"`: map to `string | ContentPart[]` and pass to
  core history as user message.
- Reject invalid/malformed parts with JSON-RPC error (`-32602 invalid params`).

### 5.2 Provider path

- Reuse existing serializer support for `ContentPart.image_url`.
- No provider-specific branching in TUI.

### 5.3 Session persistence

- `run.start` session record stores `input` as sent (text or parts).
- Existing history replay remains valid; rendering can keep image as `[image]`
  placeholder until richer UI support exists.

---

## 6. Clipboard encoding policy

Phase 1 policy:

- TUI reads clipboard image pixels via `arboard`.
- On WSL, if native clipboard image read is unavailable, TUI falls back to
  Windows clipboard via `powershell.exe` (`Get-Clipboard -Format Image`).
- Encode to PNG and wrap as `data:image/png;base64,...` URL.
- Attach as `image_url` content part.

Limits:

- Default max encoded payload per image: 5 MiB.
- Default max image attachments per message: 3.
- Exceeding limits should show actionable TUI error and keep current input text.

Rationale:

- Data URL keeps runtime stateless for image transport in phase 1.
- PNG avoids lossy conversion and simplifies deterministic tests.

---

## 7. TUI rendering/logging policy

- Input area shows concise attachment badges (e.g. `[img: 1280x720 420KB]`).
- Log for submitted user message may show image placeholder (`[image]`) plus
  original text.
- Do not print base64/data URL in logs.

---

## 8. Error handling

- Clipboard unavailable/read error -> status line error (non-fatal).
- Clipboard contains non-image only -> info line (`no image in clipboard`).
- Encoding failure -> error line (`failed to encode clipboard image`).
- Runtime rejects parts -> keep attachments locally and show error.

---

## 9. Testing plan

### Rust TUI

- Unit test: attachment state transitions (append/clear/retry).
- Unit test: key handling for `Alt+V` when dialogs are open (no mutation).
- Unit test: payload limit enforcement.

### Protocol/runtime (TypeScript)

- Runtime handler accepts `RunInputText` and `RunInputParts`.
- Invalid parts return `invalid params`.
- Session record includes `input.type = "parts"` without truncating structure.

### Integration smoke (opt-in)

- Paste image -> run.start(parts) -> provider request built with image part.

---

## 10. Rollout phases

1. Protocol + runtime input union support.
2. TUI attachment state + `Alt+V` image paste.
3. Basic attachment indicator in input panel and submit path.
4. Optional follow-up: richer attachment management commands/UI.

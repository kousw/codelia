# Clipboard adapter rules

- Accept paths only from a typed file clipboard selection. Terminal text paste
  stays editable text, including file URLs and drag-and-drop paths.
- Preserve the native path for the host read. Reject remote URI authorities and
  never interpolate clipboard data into command strings.
- Bound bridge subprocess stdout and waits. Keep file paths and clipboard bytes
  out of diagnostics and runtime RPCs.

# Attachment transfer invariants

- Authorize uploads by the active connection and session binding. Bind unbound
  draft uploads only during fresh session admission. Explicit session switches
  and resets discard the unbound draft.
- Validate canonical base64, ordered offsets, declared size and SHA-256 before
  the original can be admitted. Identical retries keep their acknowledged offset
  and attachment ID within the upload lease.
- Publish the durable ownership batch before recording a message that links it.
  Cancellation and expiry release provisional bytes. Keep admitted originals
  for conversation history, including after archive and compaction.
- Derive names, types and image dimensions from sanitized metadata and original
  bytes. Preserve original bytes and keep source paths out of stored references.

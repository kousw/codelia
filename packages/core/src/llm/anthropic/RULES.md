# Anthropic replay rules

- Keep provider-specific prefix fingerprints in raw history, never the wire or
  shared configuration. Fingerprints compare inputs; Claude validates signatures.
- Preserve thinking bytes/signatures, empty blocks and original block order.
  Compute fingerprints after serialization and orphan filtering, against the
  exact system/tools/messages sent. A changed prefix must not forward stale
  reasoning; it must still admit newly generated reasoning on following turns.
- Local input failures must use createProviderValidationError. Do not downgrade
  forced tool choice, switch models/auth, or retry a successful/failed request
  to repair a signature implicitly.

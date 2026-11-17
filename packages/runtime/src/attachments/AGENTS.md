# Runtime attachment uploads

`service.ts` owns connection-local transfer state, byte reservations and durable
admission through `AttachmentStore`. Pending uploads occupy bounded memory with
a lease and require re-upload after process restart. Pinned Steer inputs survive
expiry while the run owns them. Admitted originals remain usable through storage
and session history across restart.

`local.ts` chooses the default file store for TUI-local contracts. Embedded
hosts opt in through `RuntimeHostAdapters.stores.attachmentStore` and may lower
limits through `attachmentUploadLimits`. An adapter supplies atomic batch commit,
session-scoped integrity checks and bounded range reads. Copied images require
its image resolver and use the existing image artifact namespace locally.

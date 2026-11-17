# Composer attachments

`clipboard_import.rs` runs up to two imports off the UI thread and returns a
batch only when every selected source passes validation. `staging.rs` owns
immutable hashed copied-file bytes with a shared 128 MiB reservation across
drafts, previews and submitted snapshots. The bitmap compatibility path keeps
the existing inline image representation.

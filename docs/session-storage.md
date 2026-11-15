# Conversation storage and event compression

Codelia keeps original conversation messages in the append-only
`sessions/messages/<session_id>.jsonl` archive. Compaction changes only the model's
active context, stored separately in `sessions/contexts/<session_id>.json` with
metadata in `sessions/state.db`. Images and tool-output references remain separate.

The agent can use `conversation_search` and `conversation_read` to retrieve prior
decisions, exact wording and details missing from a compaction summary. These tools
search only the current session and return bounded snippets/text windows with stable
message IDs and continuation cursors. Retrieved text is historical evidence; it does
not replay old tool calls or replace current instructions. Normal resume loads only
the active checkpoint, without loading the entire original conversation.

Existing saved messages are retained byte-for-byte when migrated. Originals removed
by compaction before this feature cannot be recreated from the saved snapshot;
existing run events remain available for UI history replay.
After migration, use writers that support the original-archive format; older
versions treat `messages/` as a replaceable snapshot and cannot safely write it.

Normal run logs retain conversation events and compact usage. For unpinned sessions,
30-day-old runs and archived sessions are compressed to `.jsonl.gz`, not expired.
Archival removes full diagnostic request/response/tool records and header prompts/tools
while retaining conversation events and usage. History replay and ATIF read both
plain and compressed files. Compression verifies the retained data before committing.
Pinning prevents automatic conversion and diagnostic removal even while archived.
Previously compressed mixed logs are cleaned once; converted archives are marked
so subsequent maintenance does not rewrite them.

In the TUI:

```text
/session list
/session list --all
/session pin
/session unpin
/session archive
/session unarchive
```

Lifecycle commands default to the current session; append a full session ID to target
another session. `list --all` includes archived sessions and other workspaces.
Resuming unarchives a session. Archive of the current active run is rejected.

From a terminal:

```sh
codelia session list
codelia session pin <session_id>
codelia session archive <session_id>
codelia session unpin <session_id>
codelia session unarchive <session_id>
codelia session cleanup
```

Maintenance runs at local runtime startup, after archive/unpin operations, or on
manual cleanup. There is no periodic timer. Active writers, pinned sessions and
unrecognized/unsafe files are retained. Results report compressed files, expired
diagnostic files, skips, failures and reclaimed bytes. Messages, active contexts,
indexes, usage, image/tool references and task data are never collected.

`CODELIA_SESSION_DUMP=1` explicitly enables full request/response/tool dumps under
`sessions/diagnostics/`; default is off. These diagnostic files may expire after
30 days or archive if unpinned. Embedded diagnostics in legacy plain/gzip logs are
also removed when the run meets the same archival conditions.
`CODELIA_DIAGNOSTICS=1` controls live diagnostic display independently.

Usage is also retained without message bodies at `usage/YYYY/MM/DD/<run_id>.jsonl`
under the storage root. Legacy usage is extracted before event maintenance. ATIF is
only generated when `CODELIA_ATIF_OUT` is set in headless prompt mode and does not
require a full diagnostic dump.

The default root is `~/.codelia`. With `CODELIA_LAYOUT=xdg`, session state and usage
live under `$XDG_STATE_HOME/codelia` (default `~/.local/state/codelia`).

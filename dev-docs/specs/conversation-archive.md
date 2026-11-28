# Original conversation archive and active context

Status: Implemented (updated 2026-11-15); verification uses temporary stores and mocked models.

## Decision

Conversation originals and the model's active context have different lifetimes.
Compaction changes only the active view. It must not erase originals. UI event
logs remain a separate replay projection and are compressed, never expired.

Full request snapshots repeatedly duplicate prior messages and inline payloads.
Store original messages once and compress event logs to preserve conversation
history without retaining repeated request snapshots by default.

## Persistence and ownership

- `sessions/messages/<session_id>.jsonl` is the append-only canonical archive:
  one original provider-neutral BaseMessage per line. Retain original content,
  roles, tool-call identities and durable image/tool references. Do not append
  full request snapshots, regenerated startup system prompts or compaction summaries.
- `sessions/contexts/<session_id>.json` is the latest active checkpoint, containing
  the current model-facing messages and the archive boundary covered by the view.
  Ordinary saves replace this bounded active snapshot, never the original archive.
- `sessions/state.db` continues owning session metadata and pin/archive flags.
  A version flag distinguishes legacy message snapshots from original archives.
- Stable message IDs encode the immutable byte offset of each original JSONL
  entry (`m<offset>`). They are scoped to a session and survive compaction/restart.
- Core exposes an optional awaited history recorder on AgentSession. The runtime
  supplies it only when its session store supports archival writes. Core remains
  independent of storage, filesystem paths, compression and authentication.

## Capture and compaction sequence

1. Record admitted user messages, polled external user messages, canonical model
   response messages and original tool results once, before trimming/compaction.
2. Await archive persistence before replacing the active history with compacted
   messages. Archival failure stops the transition rather than silently losing
   originals. Tool-cache processing changes only the active projection.
3. Persist a new active checkpoint after successful compaction and on the existing
   debounced/final save boundaries. It includes the summary and retained messages.
4. Resume reads the active checkpoint directly; it does not preload archived
   conversations. Existing history normalization and current startup context apply.

The archive is durable conversation evidence; active checkpoints retain existing
best-effort in-flight resume semantics. This change does not promise atomic
machine-state replay or rerun historical tool calls.

## Migration and consistency

- Legacy message files remain byte-for-byte intact. Before an indexed session
  starts appending originals, atomically copy its existing active messages to the
  context checkpoint, then switch the DB version under the same write guard.
- Legacy `state/<id>.json` migration remains supported. Do not recreate originals
  removed by compaction before this feature; the starting archive is the available
  saved view, while retained historical event logs remain readable.
- This is a forward storage migration. Older writers that replace `messages/`
  as an active snapshot must not write to an upgraded storage root.
- Serialize archive appends and migration with the session index write guard.
  Validate IDs, regular files and complete JSONL tails; reject unsafe/incomplete
  archives rather than overwriting them. Flush admitted original records to disk.
- Pin/archive changes never rewrite messages or active context. All image/tool
  references remain outside event-log maintenance.

## Autonomous retrieval

- Add `conversation_search` and `conversation_read` as read-only runtime tools.
  The standard child read catalog also includes these tools for its own session,
  subject to explicit delegated allowlists and parent deny rules. Both tools
  target the current session only; no caller-supplied session/path is accepted.
- Search uses literal text matching and streamed pagination (at most 1,000 entries
  scanned per page), returning stable IDs,
  roles, bounded snippets and a continuation cursor. No embedding service is needed.
- Read returns a bounded character window from an identified original message,
  with continuation information. Images are represented by references, not base64.
  Opaque provider payloads are never exposed as tool-result text.
- Tool definitions and compaction guidance explain when to retrieve prior
  decisions, exact wording and details absent from a summary. Results are labelled
  historical evidence, not new instructions; no historical tool is executed.
- Stores without the archive capability expose no retrieval tools and acquire
  no implicit access to default local storage.

## Run events and diagnostics

- Keep normal lifecycle/conversation events and compact usage. Full diagnostic
  dumps remain explicitly enabled by `CODELIA_DEBUG=session-dump`.
- For unpinned sessions, compress completed/inactive normal run logs after 30
  days since each run's last update or on archive. Pinning protects from automatic
  conversion. Existing active writer guards and final lifecycle checks remain.
- New writer markers store PID and the shared OS process identity. Before maintenance,
  a confirmed identity mismatch removes only an unchanged stale marker. Legacy PID-only
  markers and unavailable identities retain conservative liveness protection. Identity
  lookups run outside the final synchronous index guard. Linux uses boot ID/start ticks;
  macOS uses `ps` start time (second resolution, fixed C locale/UTC timezone);
  unsupported platforms and lookup failures return unknown.
- On archival, remove `llm.request`, `llm.response`, `tool.output` and header
  prompts/tools. Preserve conversation/lifecycle event bytes and compact usage;
  independent usage is saved before source conversion and included in the archive.
  Accounting records may move after the events; event sequence order is unchanged.
- Stream record prefixes and payload fragments, skipping huge diagnostic request
  lines without buffering them. Write the retained projection to unique temporary
  gzip and verify its decompressed SHA-256/byte length before committing.
- Plain-to-gzip publication never replaces a separate existing destination. Legacy
  gzip is atomically replaced after the same source/lifecycle checks. Restore the
  source mtime; conversion failures retain the source.
- Converted headers carry `meta.codelia_log_archive_version: 1`. Already-converted
  gzip is skipped on later scans; older mixed gzip is eligible for one-time cleanup.
- All replay and ATIF consumers read plain/gzip transparently and avoid double
  counting when both representations coexist after interruption. Compression
  retains historical conversation/lifecycle events while discarding diagnostic
  snapshots from both plain legacy logs and previously compressed mixed logs.
- Explicit diagnostic files may expire under the same unpinned age/archive policy
  after compact usage preservation. Originals, active context, references and
  conversation/lifecycle events are never expired by this maintenance.

## Verification boundary

Use temporary storage for all migrations/compression. Verify originals survive
multiple actual Agent compactions and reload, bounded autonomous retrieval works,
and compressed events still drive session.history and opt-in ATIF. Live provider
quality and manual terminal UX are separate from these deterministic contracts.

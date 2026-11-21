# packages/storage

## Notes

- `FileAttachmentStore` persists generic originals under `sessions/attachments/`.
  A batch marker publishes session ownership for all accepted references. Generic
  range reads verify the intersected fixed-size hash blocks, and admission checks
  the whole original. Copied visual inputs reuse `ImageArtifactStore` and store
  only attachment metadata in the generic namespace. Retention follows admitted
  conversation originals, including archived sessions. Copied visual originals
  carry private owner metadata that is checked by both attachment and image
  artifact reads. Existing inline and generated images retain workspace scope.
- `ImageArtifactStore` saves immutable PNG originals and validated provenance
  under a runtime-selected workspace scope. Read validates regular/no-follow
  bounded files, SHA-256, dimensions and metadata; `image-png.ts` bounds PNG
  structure/CRC/decompression. `resolve` produces transient model image input.
  `modelReference` admits new generated-image refs with optional fixed JPEG views
  (quality 90, 4:4:4, same dimensions); attachments/transparency stay original.
  `image-model-view.ts` uses lazy sharp, bounded processing and immutable sidecars.
  `resolve` obeys the descriptor stored in history, never upgrades legacy refs,
  rebuilds missing views or falls back. `read` always returns originals.
  No automatic image deletion/TTL exists: session references must remain usable.
  Parent artifact IDs preserve reference order and are bounded by shared
  `IMAGE_REFERENCE_MAX_COUNT` (16); provider-specific generation limits live in runtime.
  Inline attachments use `saveAttachment`, `kind: attachment`, original MIME/bytes
  (PNG/JPEG/WebP/GIF), and no invented generation provenance. Generated metadata
  without `kind` remains readable. Attachment validation is bounded signature/header
  validation via `image-size`, not full decoding; generated PNG validation stays strict.
  Original filenames are derived only from validated MIME, never caller paths.

- Resolves Codelia storage paths with a default home layout under `~/.codelia`.
- XDG layout is opt-in via `CODELIA_LAYOUT=xdg` and splits config/cache/state paths.
- Config path set includes `config.json` / `projects.json` plus the protected `credentials/` directory (`credentials/auth.json`, `credentials/mcp-auth.json`, `credentials/storage-state.json`, `credentials/.auth-store-lock.sqlite`; credential access creates `credentials/` with `0700` on POSIX and a verified owner/SYSTEM DACL on Windows; general directory initialization does not run ACL tools).
- `ProjectsPolicyStore` validates the user-owned `projects.json` sandbox policy. `default.protected_paths` and canonical project `protected_paths` entries hold absolute paths. Local runtime combines them for the lifetime of the process. When the workspace is the canonical home directory, reads may use the canonical default storage for the configured layout with the same owner, mode, and file checks. Checkout overlaps, redirected locations within the home workspace, and overlapping mode-store writes are rejected. Sandbox and project-allow trust writers share the same lock and preserve each other’s fields. An explicit per-project `trust_project_allows: false` overrides legacy trust. Writes are atomic with `0600`. Without POSIX owner verification, a valid legacy file can coexist with startup but supplies no authority. Configured private paths require owner verification and stop startup when it is unavailable.
- Credential storage primitives (`auth-lock.ts`, `atomic-file.ts`, `windows-acl.ts`, `credential-migration.ts`, `credential-backend.ts`, `macos-keychain.ts`, `auth-schema.ts`, `mcp-auth-store.ts`):
  - `withAuthStoreLock` coordinates provider and MCP auth across processes using an owner-verified SQLite `BEGIN IMMEDIATE` lock at `<configDir>/credentials/.auth-store-lock.sqlite` with a 35s wait budget (separate from `projects-store.ts`'s 1s lock). `writeFileAtomic` writes a `0600` sibling temp file inside `credentials/`, calls `fsync`, and atomically renames into place.
  - `coordinateCredentialBackendUnlocked` implements global-only `auth.storage` (`auto` | `keyring` | `file`, env `CODELIA_AUTH_STORAGE`), write-ahead `storage-state.json` (`steady` / `migrating`), split-brain prevention on locked Keychain, universal all-direction pre-write conflict detection (`CredentialConflictError`), and two-phase migration (`legacy -> credentials/`, `file -> keyring`, `keyring -> file`).
  - `MacOsKeychainClient` talks to the native `codelia-credential-helper` binary (`crates/credential-helper`) over stdin/stdout JSON pipes using services `codelia.auth` / `codelia.mcp-auth` and account `codelia-<sha256(canonical(configDir)).slice(0, 16)>`.
  - `McpAuthStore` persists v2 endpoint/issuer/client-bound MCP tokens (`version: 2`, canonical `resource_uri`, `issuer`, `token_endpoint`, `client_id`) via locked `update()`, dropping unbound legacy v1 entries with a recorded `mcp_reauth_required` notice.
- `StoragePathServiceImpl` implements the core `StoragePathService` DI interface.
- Session logs live under `sessions/YYYY/MM/DD/` and are written by `SessionStoreWriterImpl`.
- Normal run logs omit full requests/responses/raw tool output. `CODELIA_SESSION_DUMP=1`
  enables full records separately under `sessions/diagnostics/`; compact `llm.usage`
  is also persisted under `<storage-root>/usage/` and survives run-log deletion.
- `SessionStoreWriterImpl` correlates compact usage with request sequences, retaining
  only provider/name until the response or run end. Child headers may omit model;
  use header identity only as a fallback and never retain full request payloads.
- `run-log-retention.ts` archives old/archived normal events after removing diagnostic
  request/response/tool records and header prompts/tools. Explicit dump files may
  expire. Replay/ATIF use `readRunLogLines` and prefer plain files when both coexist.
  Never expire conversation/lifecycle events.
- `run-log-files.ts` owns validated candidate discovery and live-writer checks;
  new markers contain PID plus process identity from shared `process-identity.ts`.
  Before maintenance, remove only unchanged markers with a demonstrably different
  current identity; legacy/unknown identities keep the existing liveness protection.
  OS identity probes run outside the index guard; final writer checks stay synchronous.
  Markers request the helper's canonical C/UTC environment so host environment
  differences cannot cause a false mismatch. Runtime task callers keep the legacy
  default environment for persisted executor identity compatibility. Lookup failures return null.
  `run-log-usage.ts` preserves independent usage before maintenance. Retention owns
  policy/orchestration and keeps final pin/writer/source checks and publication
  synchronous inside the session index guard.
- `run-log-records.ts` streams bounded record prefixes and raw byte fragments;
  `run-log-archive.ts` retains event bytes plus canonical usage, marks the archive
  version and drops full diagnostics without buffering huge request/image lines.
  Legacy gzip is atomically replaced only after decoded projection verification;
  converted gzip is skipped on later maintenance runs.
- `run-log-request-model.ts` selects only top-level request seq/provider/name,
  even after huge input values. Complete missing canonical usage identity from
  requests before removing diagnostics; header identity is the final fallback.
- `messages/` retains append-only original BaseMessages; `contexts/` stores the active
  view plus its original-byte boundary. `appendMessages` is awaited before Agent
  admissions; `save` updates only active context/metadata, seeding legacy originals.
- `conversation-archive.ts` provides stable byte-offset IDs and bounded same-session
  reads/search. Preserve original bytes, including legacy CRLF, and reject torn tails.
- Historical shell approval reads only archived raw user input with runtime-recorded workspace and cwd identities. `session_approval_steers` records canonical applied events by session, run, and Steer ID. Archiving a polled Steer is insufficient to reuse it as approval evidence.
- Lifecycle columns and archive format version live in state.db independently of
  active snapshots. Migration retains legacy message bytes before switching format.
- `RunEventStoreFactoryImpl` creates per-run stores; full dumps remain opt-in.
- `session-run-index.ts` + `SessionStateStoreImpl.recordSessionRun/listSessionRuns`
  keep `state.db.session_runs` (session -> run log). Writers record the row on the
  header append; `listSessionRuns` falls back to one store-wide header scan only
  until the backfill marker exists and the session's latest `run_id` is indexed
  or already checked. Never discover a session's runs by scanning headers in new
  code; session-scoped retention uses `collectRunLogCandidatesAt`.
- Session summary rows persist optional `workspace_root` (sourced from `SessionState.meta.codelia_workspace_root`) so runtime resume pickers can stay current-worktree-scoped by default.
- `SessionStateStoreImpl` opens SQLite lazily on first DB use (not constructor time) to avoid test/runtime races when temp storage roots are removed quickly.
- Legacy snapshots under `sessions/state/<session_id>.json` are still readable and are migrated on load.
- `ToolOutputCacheStoreImpl.read` always returns a bounded truncated preview: long lines are clipped on grapheme boundaries and oversized reads are truncated with continuation hints.
- `ToolOutputCacheStoreImpl.readLine` reads one physical line by character window (`line_number`, `char_offset`, `char_limit`) for huge single-line outputs.
- `ToolOutputCacheStoreImpl` caps are env-overridable: `CODELIA_TOOL_OUTPUT_CACHE_MAX_READ_BYTES` (default 65536), `CODELIA_TOOL_OUTPUT_CACHE_MAX_GREP_BYTES` (default 65536), `CODELIA_TOOL_OUTPUT_CACHE_MAX_LINE_LENGTH` (default 1000).
- `ToolOutputRef.line_count` from `ToolOutputCacheStoreImpl.save` is based on physical line count.
- `TaskRegistryStore` persists one JSON file per task under `<storage-root>/tasks/` (per-task files avoid shared-blob lost updates across runtimes).
- Persisted `TaskRecord` also carries optional public/display metadata (`key`, `label`, `title`, `working_directory`) so shell-task follow-up keys and status/list survive runtime restarts without depending on in-memory executor state.

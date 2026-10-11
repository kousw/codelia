# Explicit desktop worktree application service

Status: **Partial / implemented create-list-open slice**, 2026-10-07. Destructive lifecycle and worktree-leased task execution remain planned.

## Ownership and common route

Desktop views and the run-scoped `codelia_app` tool use the same pure application commands. Commands emit typed `worktree.list` / `worktree.create` RPCs; runtime `WorktreeService` owns filesystem/Git operations. The Git-add primitive is shared with LaneManager; desktop creation never invokes LaneManager's mux/agent launch. Existing lane behavior is preserved.

Each open checkout has its own runtime and thread/session projection. Actual canonical Git common-directory identity produces a project ID, so primary/linked checkouts group into one project while their threads remain scoped to the real checkout root. The app reports workspace path and project identity in thread/status results. Create records retain the originating thread/draft ID and source worktree; draft IDs are historical association labels, not execution authority or separately persisted UI drafts.

Children still support only `live_workspace` and execute in their owning parent's runtime worktree. Opening another checkout does not transfer existing children or cancel them. No worktree mode/lease was added to task spawning. A separate runtime opened in the new checkout may later run its own normal agent/children on explicit user send.

## Contract and failure handling

- `supports_worktrees` is optional and enabled only for the TUI-local environment with runtime processes and filesystem enabled. Legacy/embedded hosts remain compatible; disabled methods reject without filesystem work. `worktree.list` accepts no parameters and binds to the runtime root, never mutable UI cwd.
- List returns actual Git registrations, branch/HEAD, current/available/dirty/changed-file/locked/prunable state, project identity and persistent operation records. Missing/replaced/unreadable paths have unknown dirty state and an error. No pruning/removal occurs. At most 100 registrations and 100 operations are returned; older records remain on disk.
- `worktree.create` accepts bounded `operation_id`, `title`, optional `base_ref` (HEAD default), `thread_id`, optional exact active `run_id`. Client-selected path/branch/setup/force flags are rejected. Runtime resolves a commit before confirmation; a later moving HEAD cannot change this intent's base.
- Generated branch: `codelia/worktree/<operation_id>`. Files/records: resolved Codelia storage root under `worktrees/<project-id>/trees/<operation-id>` and `operations/<operation-id>/record.json`. Source dirty/untracked files stay in place; only committed base content is checked out. No credential/environment file copying.
- Every new intent requires exact once-only UI approval with structured actor, origin thread, source, destination, branch and committed SHA. UI renders scope as literal text. Internal agents can request creation but cannot approve it or automatically open another checkout. Their confirmation is cancelled with the originating parent Stop signal; a cancelled request cannot execute a late approval. Normal parent completion preserves an already admitted exact intent, whose original scope stays visible; another run cannot revoke or approve it. Once admitted, Git creation is not rolled back by parent Stop.
- Exclusive operation directories plus atomically replaced records serialize duplicate intents across service instances. Repeated IDs return the existing record; differing payload/source is rejected. A pending record outside its live service, or ready record without an available Git registration, is observed as `unknown` with `recorded_phase`; the journal stays unchanged. Corrupt/missing reservations appear as bounded unknown rows without hiding actual Git observations. Retrying those reservations rejects; pending/failed/cancelled intents are never automatically replayed or reset.
- Creation disables Git hooks, submodule recursion and fsmonitor. It registers an empty checkout first, checks destination-specific configuration and then populates committed files. Configured clean/smudge/process filters are rejected; dirty status also remains unknown if filters would execute. Dependency/setup scripts never run automatically. A failure preserves any created branch/path/files and records `failed`; callers inspect before choosing a new intent.

## Native interaction

The compact sidebar has a bounded, scrollable project-worktree list, Refresh and **New worktree from HEAD…**. The create button is disabled while input/history/create is pending. Available rows open explicitly; the adapter revalidates the shared Git common directory immediately before navigation. Existing drafts and active runs remain in their original workspace. Creation results never navigate or claim successful execution before the actual result. New list requests supersede older observations, including pre-create responses arriving late; disconnect invalidates cached availability.

Custom title/base selection is currently available through the typed internal intent/API, while the minimal human control uses HEAD and a default title. Actual OS-native input/layout/connected-flow QA remains unverified because no CUA tools are exposed. Headless GPUI bounds/input checks are separate evidence.

## Thread and restart consistency

Project IDs continue to hash the canonical common Git directory path. An additional
checkout ID hashes canonical root and root/common-directory device/inode identity;
the runtime pins it for its lifetime and rechecks after held confirmation. Replacing
the source repository at the same path cannot redirect an admitted create intent.
Native sends carry the observed checkout guard after worktree listing and wait for
pending list observation. Guarded resumes reject sessions from another checkout.

Native new drafts explicitly request fresh sessions. An unexpected session-ID
collision retains both local conversations and cancels that admitted run. A lost
connection marks pending work as interrupted/unknown, discards provisional stream
text, retains unsent drafts in memory, and refreshes only read observations on
reconnect. Late replies cannot revive or replay a discarded request. Model setting
uses exact bound-session comparison; history/model caches stay scoped to sessions.

Current acknowledged drafts have a separate [local restart store](drafts.md).
These admission and observation guards do not provide all-tool filesystem leases,
in-place repository-content identity,
or durable cancellation/reconciliation for every runtime tool side effect. Non-Git
folders and legacy unguarded sessions remain outside the checkout guard. Native
connected restart/OS input validation remains open.

## Deferred lifecycle

No desktop delete, prune, merge, integrate, archive, restore or arbitrary cleanup API exists. Cleanup must account for dirty state, unsent drafts, running parents/children/processes and durable ownership/reference leases; integration additionally needs a fixed destination revision and reviewed changes. Restoration must recover files, thread associations and unknown operation state without replaying side effects. Validate those contracts with temporary repositories before real destructive operations. The full M4 product gate remains open.

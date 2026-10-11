# Worktree application service

`WorktreeService` binds to the runtime's actual Git checkout/common directory. It lists real Git registrations and records originating thread/worktree associations for explicit create intents. Stable operation IDs are persistent and never automatically replay a pending/failed/cancelled operation. Git creation is shared with LaneManager through `git.ts`; this service does not start a mux, agent or setup script.

Create confirmation must show the exact committed base, generated branch and destination. Hooks are disabled and configured checkout filters are rejected. Source dirty files are never copied/reset/stashed. Missing or replaced registered paths produce unavailable status, not clean. Delete/merge/archive/restore and worktree task leases remain outside this service.

The live service pins canonical root/common directory plus device/inode-derived checkout identity and revalidates after confirmation. Project grouping still uses the common-directory path hash. Outside the owning live service, pending records are observations of unknown outcomes, with recorded_phase retained. Missing/corrupt reservations and ready-but-unavailable registrations must remain visible as unknown; never rewrite/replay them during list.

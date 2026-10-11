# Worktree rules

- Never accept arbitrary client checkout paths, shell commands or cleanup flags.
- Keep creation distinct from starting an agent; no dependency/setup hooks run automatically.
- Use persistent operation identity and committed SHA before confirmation; preserve failure artifacts.
- Treat thread IDs as association metadata only. Approval is scoped to an exact operation; parent Stop can dismiss queued approval; normal completion preserves an admitted exact intent but cannot roll back admitted Git creation.
- Keep destructive lifecycle operations unimplemented until live process/thread/dirty guards and recovery are designed and tested.

- Pin physical checkout identity; path equality alone cannot detect same-path repository replacement. Revalidate after user confirmation.
- List/restart must be observational: unknown outcome preserves the original journal and all artifacts; corrupt records must not hide valid Git state.

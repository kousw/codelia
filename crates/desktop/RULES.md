# Native desktop rules

- Preserve run ownership independently of selected workspace/thread.
- Admit one parent run per workspace; guard repeated Send/Stop/approval.
- Never automatically retry a request whose outcome is unknown.
- Keep transcript/frame/queue/history bounds; never evict unsent draft text.
- Keep auth, permissions, sandboxing and task lifetime in runtime.
- A client tool cannot approve, modify credentials, send prompts or invoke arbitrary RPC.
- Render actual status/results; mark unsupported flows explicitly.
- Compact layout must preserve readable text, native focus/input and approval reachability.

- Use separate build artifacts and bundle identities for separate source baselines/worktrees. Verify artifact identity before reporting an interaction or regression result.

# Native desktop rules

- Preserve run ownership independently of selected workspace/thread.
- Admit one parent run per workspace; guard repeated Send/Stop/approval.
- Never automatically retry a request whose outcome is unknown.
- Keep transcript/frame/queue/history bounds; never evict unsent draft text.
- Keep auth, permissions, sandboxing and task lifetime in runtime.
- A client tool cannot approve, modify credentials, send prompts or invoke arbitrary RPC.
- Render actual status/results; mark unsupported flows explicitly.
- Compact layout must preserve readable text, native focus/input and approval reachability.

- Evict persisted transcript data independently of unsent drafts; require history replay before an evicted transcript is treated as loaded.
- Synchronize live front-row eviction by scroller splice; preserve item anchors and user tail-follow preference. Never reset merely because bounded history gets shorter.

- Resolve optional QA launch resources before starting runtime; invalid configuration must fail closed. Preserve normal checkout runtime selection and use explicit child-process environment.

- Keep input-save filesystem/Git work off the GUI thread. Coalesce input, bound current snapshots, atomically fsync/replace; retain no draft history.
- Durable consumption acknowledgement belongs to an exact action token/thread. Cancel/disconnect/quit must not release a later send from an earlier acknowledgement.
- Never automatically rebind retained text to a new physical checkout or stale-writer revision. Save/quit failure retains input without model dispatch.

- Treat an empty startup workspace list as a supported UI state. Failed folder admission leaves the window usable with an explicit picker and starts no runtime/draft worker.

- A provider catalog is not a model selection or sign-in assertion. Keep explicit choices thread-owned, pass them at admission, never rewrite config/auth for recovery.
- Show only typed subagents as child agents; preserve runtime owner scope and independent cancellation.

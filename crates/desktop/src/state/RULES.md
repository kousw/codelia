# Native desktop rules

- Preserve run ownership independently of selected workspace/thread.
- Admit one parent run per workspace; guard repeated Send/Stop/approval.
- Never automatically retry a request whose outcome is unknown.
- Keep transcript/frame/queue/history bounds; never evict unsent draft text.
- Keep auth, permissions, sandboxing and task lifetime in runtime.
- A client tool cannot approve, modify credentials, send prompts or invoke arbitrary RPC.
- Render actual status/results; mark unsupported flows explicitly.
- Compact layout must preserve readable text, native focus/input and approval reachability.

- Keep runtime-answer drafts request-local and in memory; never expose them through `codelia_app` or persist them to history/config. A stale input binding must not write to a new request.

- Preserve drafts/transcripts on session identity collision and disconnect; never replay requests or infer completion from connection loss.
- Only current read observations may reconcile unknown operation status; they cannot create or resume work.

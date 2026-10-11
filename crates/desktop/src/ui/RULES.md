# Native desktop rules

- Preserve run ownership independently of selected workspace/thread.
- Admit one parent run per workspace; guard repeated Send/Stop/approval.
- Never automatically retry a request whose outcome is unknown.
- Keep transcript/frame/queue/history bounds; never evict unsent draft text.
- Keep auth, permissions, sandboxing and task lifetime in runtime.
- A client tool cannot approve, modify credentials, send prompts or invoke arbitrary RPC.
- Render actual status/results; mark unsupported flows explicitly.
- Compact layout must preserve readable text, native focus/input and approval reachability.

- Icon-only navigation/panel actions require accessible names and discoverable tooltips. Preserve reachable close/navigation actions at the minimum window width.

- Kit centers its inner button labels separately from outer alignment. Navigation uses a full-width text child plus an explicit accessible name to keep text left aligned.
- Failed/loading repository observations are not clean working trees. Show unavailable/reading state until an observation succeeds.

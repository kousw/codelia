# App state lifecycle

`methods.rs` owns shared run-status transitions. New calls/turns reset run
duration and provisional output, but retain last-known TPS and remaining context
until the runtime supplies replacement measurements. Missing telemetry is not a
reset. Keep lifecycle regression coverage in `tests.rs` and notification-level
coverage in `handlers/runtime_response/tests.rs`.

`clipboard_import.rs` binds each in-flight import to an atomic marker in the
current composer. Resolve the marker in place even when jobs finish in reverse
order. Clear, deletion and session switches prevent late completions from
changing the composer. Snapshot staged files before clearing a submitted draft.

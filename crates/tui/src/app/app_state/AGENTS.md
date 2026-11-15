# App state lifecycle

`methods.rs` owns shared run-status transitions. New calls/turns reset run
duration and provisional output, but retain last-known TPS and remaining context
until the runtime supplies replacement measurements. Missing telemetry is not a
reset. Keep lifecycle regression coverage in `tests.rs` and notification-level
coverage in `handlers/runtime_response/parsed_output.rs`.

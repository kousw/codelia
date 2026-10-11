# RPC rules

- Preserve legacy clients when adding optional notifications; require explicit capability opt-in.
- Keep child task lifetime separate from parent-turn cancellation.
- Never infer approval authority or cancellation identity from display prose.
- Preserve request/notification order and release cancelled queue slots without releasing an unrelated active request.
- Do not log credentials or raw provider failures in normal user-facing events.

- Fresh-thread intent must be explicit and mutually exclusive with resume ID; never silently merge a native draft into the last runtime session.
- Validate guarded checkout and model session identity before mutation; preflight failure must not leave an active run. Never automatically replay side effects on reconnect/restart.

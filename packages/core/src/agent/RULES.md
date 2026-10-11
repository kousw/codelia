# Agent stream rules

- Canonical successful completions alone update assistant history/usage/session records.
- Partial text belongs to one invocation/attempt; discard failed attempts before retry.
- Bound pending progress and abort a waiting provider when its consumer returns.
- Preserve caller cancellation and existing retry-window admission semantics.

# RPC authentication rules

- Validate logout names before mutation; preserve unrelated credential entries and sessions.
- Reload saved auth after UI confirmation; never log credentials or raw auth-file errors.
- Do not reinterpret unsupported scoped requests as all-provider logout.
- Invalidate cached agents and direct tools when a logged-out provider supplies their credentials, including a separate image provider; reset the session only for the current chat provider.

## LLM metrics

- Derive TPS only from finite non-negative provider output usage and a positive
  monotonic generation interval. Missing/invalid data is null, never request
  latency or a token estimate. Persist only compact accounting in `llm.usage`;
  full model payloads require the explicit session dump option.
- Hidden reasoning usage requires a matching observed reasoning interval from
  the provider adapter. Accept the shared typed activity markers rather than
  assuming every provider speaks Responses. Emit completed-call measurements
  only; null means unavailable and must not be a call-start reset signal.

## Model selection

- Validate explicit speed values and the merged candidate's model/auth capability
  before config/session writes. Ultrafast requires public OpenAI API-key auth;
  runtime-owned validation must not prompt for or switch credentials.
- For named Responses endpoints, validate the reasoning value actually inherited by the candidate before persisting it; validate the configured value on reset.
- Session reset validates the persistent target through the same admission path
  before deleting or saving the override. Validation failure preserves current
  model identity, agent, and both live/persisted session metadata.

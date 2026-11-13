# Google chat rules

- Always send `store: false`; never use server interaction IDs for replay.
- Preserve signed provider steps verbatim in local history.
- Replay a raw function call only if its ID remains in the assistant's canonical tool calls after history normalization.
- Reject partial streams and unsupported modalities before reporting success.
- Omit `thinking_level` when no effort is selected; Flash-Lite keeps its API default.
- Keep native `xhigh` for Hydrogen; runtime must resolve unsupported canonical effort by model before calling the adapter.
- Do not add automatic retries or an auth/model/endpoint fallback.

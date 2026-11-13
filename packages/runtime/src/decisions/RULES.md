# Decisions rules

- Never fall back across provider, endpoint, model or auth; these are explicit API-key operations with possible charges.
- Keep the permission gate inside the tool so direct RPC cannot bypass it. Do not acquire image bytes or call a provider before approval.
- Preserve provider probabilities and refusals; do not fabricate confidence, silently discard questions or accept incomplete/mismatched answers.
- Keep origins fixed, responses bounded and cancellable, errors redacted, and paid calls free of automatic retries.
- Images are explicit ordered references; enforce sandbox, destination and size policies before transmitting originals. Do not persist base64 in tool arguments or logs.
- Non-TUI hosts must not implicitly acquire local auth, image stores, file access or tools.

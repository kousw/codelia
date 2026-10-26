# Config rules

- Keep config validation pure and dependencies minimal.
- Named `providers` entries require a Responses base URL and positive model context limits. Reject builtin-name replacement, literal API keys, malformed limits and unsupported keys.
- Merge provider maps by endpoint name, replacing complete same-named entries. Never deep-merge models/features from another URL.

- Preserve explicit speed selection through merges; never coerce "ultrafast" into a boolean.

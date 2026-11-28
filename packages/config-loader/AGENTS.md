# @codelia/config-loader

Config file I/O (`cosmiconfig`) and locked atomic config mutations.

- Parsing/validation lives in `@codelia/config`. `updateConfigValue` updates one scalar leaf preserving unrelated raw JSON and pruning empty parents; `removePermissionRules` compares `normalizePermissionRule` forms.
- Every exported read-modify-write helper holds `withConfigFileLock` (in-process queue + SQLite write lock `<resolved-config-path>.lock.sqlite` from read through write). CLI and runtime must share this path; never delete the sidecar while another process can use it; lock failure aborts writes.
- CI builds only `@codelia/core` before typechecking; keep workspace source aliases for `@codelia/storage` and `@codelia/shared-types` resolvable without their build outputs.

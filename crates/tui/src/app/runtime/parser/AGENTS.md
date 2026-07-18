# Runtime parser

`parser.rs` owns protocol dispatch and parser-level regression tests. Keep event ordering and `ParsedOutput` behavior stable while refactoring rendering internals.

## Dependency direction

- `types.rs` owns parser output DTOs.
- `common.rs` owns small pure presentation primitives shared by multiple renderers.
- `helpers.rs` owns general protocol formatting and the single tool-result dispatcher.
- Domain renderers such as `todo.rs` may depend on `common.rs` and `app::state` presentation types.
- Domain renderers must not depend on `handlers`, `view`, `render`, `AppState`, or runtime process/RPC adapters.
- Keep terminal side effects and application-state mutation outside parser modules; renderers return `LogLine` values and metadata only.

Prefer a domain module when a renderer has its own parsing, error classification, summary, and detail rules. Do not create a broad service locator or pass the whole `AppState` to renderers.

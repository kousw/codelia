# Protocol codegen

Generates the runtime <-> UI wire artifacts from the `@codelia/protocol`
method catalog (`packages/protocol/src/catalog.ts`). Spec:
`dev-docs/specs/protocol-codegen.md`.

- `bun run generate:protocol` writes all outputs; `bun run check:protocol`
  regenerates in memory and fails on missing, extra or stale files (CI `js`
  job). Run generate after changing any catalogued schema and commit the
  outputs with the schema change.
- Outputs: `packages/protocol/schema/protocol.schema.json` (excluded from Biome),
  `packages/protocol/schema/methods.md` (method table),
  `crates/protocol/src/generated.rs` (`#[rustfmt::skip]`), and
  `packages/protocol/tests/fixtures/protocol/<route>.jsonl`.
- Pipeline: `schema.ts` (official `z.toJSONSchema`, `io: "input"`, unreachable
  defs pruned) -> `model.ts` (type dependency graph) / `check.ts` (wire subset) ->
  `rust.ts` (Rust emitter) ->
  `samples/` (one file per protocol area; fixtures validated with Zod before
  writing). `main.ts` wires
  them. Never read Zod internals (`_zod.def`).
- Depend on `@codelia/protocol` with `workspace:*`. The release version scripts
  only scan `packages/`, so a pinned version here would drift.
- Rust decode positions are runtime-originated params plus results of
  UI-originated requests, including structured error data. Untagged object
  unions are rejected there (use `tagged` or `keyed`) and become Serialize-only
  enums in encode-only positions.
- String literals outside tags emit `Lit*` unit types that reject other
  values; named literal definitions (the protocol version) stay `String`.
- Match Zod presence and shape checks: keyed unions try branches in order, required
  opaque values must be present, and structs decode from maps only. Present
  optional fields decode as their value type unless they declare nullable
  presence. Safe integer fields accept integral JSON number spellings.
  `wireCount()` is rejected in decode positions. Serialize-only dependencies
  propagate through explicit type references, including inline nodes and aliases.
- Fixture `expect` is the Rust receiver outcome (`typed` / `unknown` / `error`);
  `ts` is the Zod outcome (`valid` / `invalid` / `skip` for uncatalogued
  methods); `lossy` marks intentional re-serialization differences. Both
  languages replay every line. For strict runtime request objects, fixtures
  may declare Zod rejection and Rust diagnostic round-trip with dropped keys.

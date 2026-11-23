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
  `crates/tui/src/protocol/generated.rs` (`#[rustfmt::skip]`), and
  `packages/protocol/tests/fixtures/protocol/<route>.jsonl`.
- Pipeline: `schema.ts` (official `z.toJSONSchema`, `io: "input"`, unreachable
  defs pruned) -> `check.ts` (wire subset) -> `rust.ts` (Rust emitter) ->
  `samples/` (one file per protocol area; fixtures validated with Zod before
  writing). `main.ts` wires
  them. Never read Zod internals (`_zod.def`).
- Depend on `@codelia/protocol` with `workspace:*`. The release version scripts
  only scan `packages/`, so a pinned version here would drift.
- Rust decode positions are runtime-originated params plus results of
  UI-originated requests. Untagged object unions are rejected there (use
  `tagged` or `keyed`) and become Serialize-only enums in encode-only positions.
- String literals outside tags emit `Lit*` unit types that reject other
  values; named literal definitions (the protocol version) stay `String`.
- Fixture `expect` is the Rust receiver outcome (`typed` / `unknown` / `error`);
  `ts` is the Zod outcome (`valid` / `invalid` / `skip` for uncatalogued
  methods); `lossy` marks intentional re-serialization differences. Both
  languages replay every line.
